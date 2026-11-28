import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore } from './indexStore.js'
import { runMigrations } from './migrate.js'

const vec = (value: number): number[] => Array.from({ length: 768 }, () => value)

const chunk = (ordinal: number, content: string, value = ordinal + 1): ChunkWrite => ({
  ordinal,
  headingPath: `Note > Part ${ordinal}`,
  startLine: ordinal * 10 + 1,
  endLine: ordinal * 10 + 5,
  content,
  embedding: vec(value),
})

const doc = (relPath: string, contentHash: string, allowLlm = true) => ({
  path: relPath,
  title: relPath.replace(/\.md$/, ''),
  language: 'markdown',
  contentHash,
  allowLlm,
  mtime: new Date('2026-11-25T12:00:00Z'),
})

// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('Postgres index store', () => {
  const dbName = `pythia_store_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: IndexStore
  let sourceId: number

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    // DROP DATABASE ... WITH (FORCE) in afterAll can kill a client that is
    // still closing (57P01); without a handler that is an unhandled error.
    pool.on('error', () => {})
    // Same for errors raised on an individual checked-out client.
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
    store = createPgIndexStore(pool)
    sourceId = (await ensureSource(pool, 'obsidian', 'vault', '/vault')).id
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('ensureSource reuses the row and updates root_path', async () => {
    const again = await ensureSource(pool, 'obsidian', 'vault', '/mnt/vault')
    expect(again).toEqual({ id: sourceId, enabled: true })
    const { rows } = await pool.query('SELECT root_path FROM sources WHERE id = $1', [sourceId])
    expect(rows[0]?.root_path).toBe('/mnt/vault')
  })

  it('writes a document with chunks and reads its state back', async () => {
    await store.replaceDocument(sourceId, doc('a.md', 'h1'), [chunk(0, 'alpha text'), chunk(1, 'beta text')], 'nomic-embed-text')
    const states = await store.getDocumentStates(sourceId, 'nomic-embed-text')
    expect(states.get('a.md')).toEqual({ contentHash: 'h1', allowLlm: true, stale: false, tags: [], linksKey: '[]' })

    const { rows } = await pool.query<{ ordinal: number; embed_model: string; dims: number; start_line: number }>(
      `SELECT c.ordinal, c.embed_model, vector_dims(c.embedding) AS dims, c.start_line
       FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'a.md' ORDER BY c.ordinal`,
    )
    expect(rows).toEqual([
      { ordinal: 0, embed_model: 'nomic-embed-text', dims: 768, start_line: 1 },
      { ordinal: 1, embed_model: 'nomic-embed-text', dims: 768, start_line: 11 },
    ])
  })

  it('replaces all chunks on re-index and keeps the document id', async () => {
    const before = await pool.query<{ id: string }>("SELECT id FROM documents WHERE path = 'a.md'")
    await store.replaceDocument(sourceId, doc('a.md', 'h2', false), [chunk(0, 'gamma only\u0000')], 'nomic-embed-text')
    const after = await pool.query<{ id: string; content_hash: string; allow_llm: boolean }>(
      "SELECT id, content_hash, allow_llm FROM documents WHERE path = 'a.md'",
    )
    expect(after.rows[0]).toEqual({ id: before.rows[0]?.id, content_hash: 'h2', allow_llm: false })
    const chunks = await pool.query<{ content: string }>(
      "SELECT content FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'a.md'",
    )
    // NUL is stripped rather than failing the insert.
    expect(chunks.rows.map((row) => row.content)).toEqual(['gamma only'])
  })

  it('reports chunks from another embedding model as stale', async () => {
    const states = await store.getDocumentStates(sourceId, 'other-model', ['a.md'])
    expect(states.get('a.md')?.stale).toBe(true)
  })

  it('stores a document with no chunks', async () => {
    await store.replaceDocument(sourceId, doc('empty.md', 'h0'), [], 'nomic-embed-text')
    const states = await store.getDocumentStates(sourceId, 'nomic-embed-text', ['empty.md', 'missing.md'])
    expect([...states.keys()]).toEqual(['empty.md'])
    expect(states.get('empty.md')?.stale).toBe(false)
  })

  it('setAllowLlm flips the flag only', async () => {
    await store.setAllowLlm(sourceId, 'a.md', true)
    const states = await store.getDocumentStates(sourceId, 'nomic-embed-text', ['a.md'])
    expect(states.get('a.md')).toMatchObject({ contentHash: 'h2', allowLlm: true })
  })

  it('rolls back the whole write when a chunk is invalid', async () => {
    const bad = { ...chunk(0, 'bad'), embedding: vec(1).slice(0, 10) }
    await expect(store.replaceDocument(sourceId, doc('a.md', 'h3'), [bad], 'nomic-embed-text')).rejects.toThrow()
    const states = await store.getDocumentStates(sourceId, 'nomic-embed-text', ['a.md'])
    expect(states.get('a.md')?.contentHash).toBe('h2')
    const count = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'a.md'",
    )
    expect(Number(count.rows[0]?.n)).toBe(1)
  })

  it('deletes documents and cascades to chunks', async () => {
    expect(await store.deleteDocuments(sourceId, ['a.md', 'nope.md'])).toBe(1)
    expect(await store.deleteDocuments(sourceId, [])).toBe(0)
    const left = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'a.md'",
    )
    expect(Number(left.rows[0]?.n)).toBe(0)
    const states = await store.getDocumentStates(sourceId, 'nomic-embed-text')
    expect([...states.keys()]).toEqual(['empty.md'])
  })
})

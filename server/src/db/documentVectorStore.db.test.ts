import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { backfillDocumentVectors } from './documentVectorStore.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore } from './indexStore.js'
import { runMigrations } from './migrate.js'

const MODEL = 'nomic-embed-text'

/** A 768-dim vector whose values differ by position, so a wrong mean shows. */
const vec = (scale: number): number[] => Array.from({ length: 768 }, (_, i) => scale * ((i % 4) + 1) * 0.25)

const chunk = (ordinal: number, embedding: number[]): ChunkWrite => ({
  ordinal,
  headingPath: '',
  startLine: null,
  endLine: null,
  content: `chunk ${ordinal}`,
  embedding,
})

const doc = (docPath: string, contentHash = 'h') => ({
  path: docPath,
  title: docPath,
  language: null,
  contentHash,
  allowLlm: true,
  mtime: null,
})

const mean = (vectors: number[][]): number[] =>
  vectors[0]!.map((_, i) => vectors.reduce((sum, v) => sum + v[i]!, 0) / vectors.length)

// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('document_vectors (R20 map vectors)', () => {
  const dbName = `pythia_docvec_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: IndexStore

  const vectorOf = async (sourceId: number, docPath: string): Promise<{ embedding: number[]; model: string } | null> => {
    const { rows } = await pool.query<{ embedding: string; embed_model: string }>(
      `SELECT v.embedding::text AS embedding, v.embed_model
       FROM document_vectors v JOIN documents d ON d.id = v.document_id
       WHERE d.source_id = $1 AND d.path = $2`,
      [sourceId, docPath],
    )
    const row = rows[0]
    return row === undefined ? null : { embedding: JSON.parse(row.embedding) as number[], model: row.embed_model }
  }

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
    store = createPgIndexStore(pool)
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('stores the mean of a note’s chunk embeddings with its embed_model', async () => {
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    const vectors = [vec(1), vec(2), vec(6)]
    await store.replaceDocument(vault.id, doc('Ideas.md'), vectors.map((v, i) => chunk(i, v)), MODEL)
    const stored = await vectorOf(vault.id, 'Ideas.md')
    expect(stored?.model).toBe(MODEL)
    const expected = mean(vectors)
    expect(stored?.embedding).toHaveLength(768)
    stored?.embedding.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 5))
  })

  it('refreshes the vector when the document is re-indexed', async () => {
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    await store.replaceDocument(vault.id, doc('Ideas.md', 'h2'), [chunk(0, vec(4))], MODEL)
    const stored = await vectorOf(vault.id, 'Ideas.md')
    stored?.embedding.forEach((value, i) => expect(value).toBeCloseTo(vec(4)[i]!, 5))
  })

  it('removes the vector when every chunk is gone (all dropped by the secrets scanner)', async () => {
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    await store.replaceDocument(vault.id, doc('Ideas.md', 'h3'), [], MODEL)
    expect(await vectorOf(vault.id, 'Ideas.md')).toBeNull()
    await store.replaceDocument(vault.id, doc('Empty.md'), [], MODEL)
    expect(await vectorOf(vault.id, 'Empty.md')).toBeNull()
  })

  it('gives Keep notes and Drive documents a vector', async () => {
    const keep = await ensureSource(pool, 'keep', 'keep', 'takeout')
    const drive = await ensureSource(pool, 'gdrive', 'gdrive', '/data/gdrive')
    await store.replaceDocument(keep.id, doc('Keep/List.json'), [chunk(0, vec(1))], MODEL)
    await store.replaceDocument(drive.id, doc('Plans/plan.docx'), [chunk(0, vec(1))], MODEL)
    expect(await vectorOf(keep.id, 'Keep/List.json')).not.toBeNull()
    expect(await vectorOf(drive.id, 'Plans/plan.docx')).not.toBeNull()
  })

  it('keeps repo code and boilerplate out of the map, README and docs in', async () => {
    const repo = await ensureSource(pool, 'repo', 'demo', '/mirrors/demo')
    for (const docPath of ['README.md', 'docs/setup.md', 'src/index.ts', 'LICENSE', 'package.json']) {
      await store.replaceDocument(repo.id, doc(docPath), [chunk(0, vec(1)), chunk(1, vec(3))], MODEL)
    }
    const { rows } = await pool.query<{ path: string }>(
      `SELECT d.path FROM document_vectors v JOIN documents d ON d.id = v.document_id
       WHERE d.source_id = $1`,
      [repo.id],
    )
    expect(rows.map((row) => row.path).sort()).toEqual(['README.md', 'docs/setup.md'])
    // The code file is still indexed and searchable; it only has no map vector.
    const code = await pool.query("SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.path = 'src/index.ts'")
    expect(code.rowCount).toBe(2)
  })

  it('never gives a work document a vector', async () => {
    const work = (
      await pool.query<{ id: string }>(
        "INSERT INTO sources (kind, name, root_path) VALUES ('work', 'work', '/work') RETURNING id",
      )
    ).rows[0]!.id
    await store.replaceDocument(Number(work), doc('plan.md'), [chunk(0, vec(1))], MODEL)
    expect(await vectorOf(Number(work), 'plan.md')).toBeNull()
    expect(await backfillDocumentVectors(pool)).toBe(0)
    expect(await vectorOf(Number(work), 'plan.md')).toBeNull()
  })

  it('backfills documents indexed before document_vectors from stored chunks only', async () => {
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    const repo = await ensureSource(pool, 'repo', 'demo', '/mirrors/demo')
    // Written straight into chunks, like rows stored before the migration.
    // The backfill takes no embedder, so Ollama cannot be called.
    const old = (
      await pool.query<{ id: string }>(
        "INSERT INTO documents (source_id, path, title, content_hash) VALUES ($1, 'Old.md', 'Old', 'h') RETURNING id",
        [vault.id],
      )
    ).rows[0]!.id
    const oldCode = (
      await pool.query<{ id: string }>(
        "INSERT INTO documents (source_id, path, title, content_hash) VALUES ($1, 'src/old.ts', 'old', 'h') RETURNING id",
        [repo.id],
      )
    ).rows[0]!.id
    const vectors = [vec(2), vec(8)]
    for (const [id, i] of [
      [old, 0],
      [old, 1],
      [oldCode, 0],
    ] as const) {
      await pool.query(
        "INSERT INTO chunks (document_id, ordinal, content, embedding, embed_model) VALUES ($1, $2, 'x', $3::vector, $4)",
        [id, i, `[${vectors[i]!.join(',')}]`, MODEL],
      )
    }
    const before = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document_vectors')

    expect(await backfillDocumentVectors(pool)).toBe(1)
    const stored = await vectorOf(vault.id, 'Old.md')
    expect(stored?.model).toBe(MODEL)
    const expected = mean(vectors)
    stored?.embedding.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 5))
    expect(await vectorOf(repo.id, 'src/old.ts')).toBeNull()

    const after = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document_vectors')
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1)
    // A second run finds nothing left to do.
    expect(await backfillDocumentVectors(pool)).toBe(0)
  })

  it('drops the vector with its document', async () => {
    const repo = await ensureSource(pool, 'repo', 'demo', '/mirrors/demo')
    expect(await store.deleteDocuments(repo.id, ['README.md'])).toBe(1)
    expect(await vectorOf(repo.id, 'README.md')).toBeNull()
  })
})

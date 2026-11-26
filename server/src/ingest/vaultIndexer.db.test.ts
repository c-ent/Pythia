import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { dropTestDatabase } from '../db/testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import { runMigrations } from '../db/migrate.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import { createVaultIndexer, type VaultIndexer } from './vaultIndexer.js'

// T6 verify against real Postgres: index a fixture vault twice, the second
// run must not call the embedder, and a deleted file must leave the DB.
// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('vault indexer against Postgres', () => {
  const dbName = `pythia_vault_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let root: string
  let indexer: VaultIndexer
  let embedCalls = 0

  const embedder: Embedder = {
    model: 'nomic-embed-text',
    dimensions: EMBED_DIMENSIONS,
    async embedDocuments(texts) {
      embedCalls++
      return texts.map((_, i) => Array.from({ length: EMBED_DIMENSIONS }, (_, d) => (i + 1) / (d + 1)))
    },
    async embedQuery() {
      return Array.from({ length: EMBED_DIMENSIONS }, () => 0)
    },
  }

  const put = async (relPath: string, text: string): Promise<void> => {
    const abs = path.join(root, ...relPath.split('/'))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, text)
  }

  const docs = async () =>
    (
      await pool.query<{ path: string; allow_llm: boolean; chunks: string }>(
        `SELECT d.path, d.allow_llm, count(c.id) AS chunks
         FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
         GROUP BY d.path, d.allow_llm ORDER BY d.path`,
      )
    ).rows.map((row) => ({ path: row.path, allowLlm: row.allow_llm, chunks: Number(row.chunks) }))

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

    root = await mkdtemp(path.join(tmpdir(), 'pythia-vault-db-'))
    await put('Projects/Pythia.md', '# Goals\n\nHybrid search over notes.\n\n## Risks\n\nScope creep.')
    await put('Private/diary.md', '# Today\n\nQuiet day.')
    await put('Ideas.md', '---\nllm: false\n---\n# Idea\n\nLocal only.')
    await put('.obsidian/app.md', '# settings')

    const source = await ensureSource(pool, 'obsidian', 'vault', root)
    indexer = createVaultIndexer({
      root,
      sourceId: source.id,
      store: createPgIndexStore(pool),
      embedder,
      exclusions: async () => [{ kind: 'folder', path: 'Private' }],
    })
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('indexes the fixture vault with allow_llm set', async () => {
    const result = await indexer.fullScan()
    expect(result.failed).toEqual([])
    expect(await docs()).toEqual([
      { path: 'Ideas.md', allowLlm: false, chunks: 1 },
      { path: 'Private/diary.md', allowLlm: false, chunks: 1 },
      // Short `Goals` absorbs its `Risks` subsection, so one chunk.
      { path: 'Projects/Pythia.md', allowLlm: true, chunks: 1 },
    ])
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT bool_and(vector_dims(embedding) = 768 AND embed_model = 'nomic-embed-text') AS ok FROM chunks`,
    )
    expect(rows[0]?.ok).toBe(true)
  })

  it('skips the embedder on the second run', async () => {
    const before = embedCalls
    const result = await indexer.fullScan()
    expect(result).toMatchObject({ indexed: [], unchanged: 3, deleted: [], failed: [] })
    expect(embedCalls).toBe(before)
  })

  it('removes a deleted file from the database', async () => {
    await unlink(path.join(root, 'Ideas.md'))
    const result = await indexer.fullScan()
    expect(result.deleted).toEqual(['Ideas.md'])
    expect((await docs()).map((doc) => doc.path)).toEqual(['Private/diary.md', 'Projects/Pythia.md'])
  })
})

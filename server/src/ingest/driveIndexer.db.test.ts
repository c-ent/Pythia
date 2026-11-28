import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import { runMigrations } from '../db/migrate.js'
import { dropTestDatabase } from '../db/testDatabase.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { OfficeConverter } from './driveConvert.js'
import { createDriveIndexer, type DriveIndexer } from './driveIndexer.js'
import { docxFile, pdfFile, PNG_BYTES } from './testDriveFiles.js'

// T60 verify against real Postgres: index a fixture mirror as a `gdrive`
// source, the second run must not call the embedder, a deleted file must leave
// the DB and an emptied mirror must delete nothing. Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('drive indexer against Postgres', () => {
  const dbName = `pythia_drive_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let root: string
  let indexer: DriveIndexer
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

  const converter: OfficeConverter = () => Promise.reject(new Error('no LibreOffice in this test'))

  const put = async (relPath: string, bytes: Uint8Array | string): Promise<void> => {
    const abs = path.join(root, ...relPath.split('/'))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, bytes)
  }

  const docs = async () =>
    (
      await pool.query<{ kind: string; path: string; title: string; allow_llm: boolean; chunks: string }>(
        `SELECT s.kind, d.path, d.title, d.allow_llm, count(c.id) AS chunks
         FROM documents d JOIN sources s ON s.id = d.source_id LEFT JOIN chunks c ON c.document_id = d.id
         GROUP BY s.kind, d.path, d.title, d.allow_llm ORDER BY d.path`,
      )
    ).rows.map((row) => ({
      kind: row.kind,
      path: row.path,
      title: row.title,
      allowLlm: row.allow_llm,
      chunks: Number(row.chunks),
    }))

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)

    root = await mkdtemp(path.join(tmpdir(), 'pythia-gdrive-db-'))
    await put('Work/Minutes.docx', docxFile([{ heading: 1, text: 'Decisions' }, { paragraph: 'Ship the beta.' }]))
    await put('Papers/Report.pdf', pdfFile([['First page'], ['Second page']]))
    await put('Notes/todo.md', '# Todo\n\nCall the bank.')
    await put('Photos/cat.png', PNG_BYTES)

    const source = await ensureSource(pool, 'gdrive', 'drive', root)
    indexer = createDriveIndexer({ root, sourceId: source.id, store: createPgIndexStore(pool), embedder, converter })
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('indexes the fixture mirror as gdrive with allow_llm true', async () => {
    const result = await indexer.fullScan()
    expect(result.failed).toEqual([])
    expect(result.skipped.not_document).toBe(1)
    expect(await docs()).toEqual([
      { kind: 'gdrive', path: 'Notes/todo.md', title: 'todo', allowLlm: true, chunks: 1 },
      { kind: 'gdrive', path: 'Papers/Report.pdf', title: 'Report', allowLlm: true, chunks: 2 },
      { kind: 'gdrive', path: 'Work/Minutes.docx', title: 'Minutes', allowLlm: true, chunks: 1 },
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
    await unlink(path.join(root, 'Notes', 'todo.md'))
    const result = await indexer.fullScan()
    expect(result.deleted).toEqual(['Notes/todo.md'])
    expect((await docs()).map((doc) => doc.path)).toEqual(['Papers/Report.pdf', 'Work/Minutes.docx'])
  })

  it('deletes nothing when the mirror is emptied', async () => {
    for (const dir of ['Work', 'Papers', 'Notes', 'Photos']) await rm(path.join(root, dir), { recursive: true, force: true })
    const result = await indexer.fullScan()
    expect(result.keptEmptyMirror).toBe(true)
    expect((await docs()).length).toBe(2)
  })
})

import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdir } from 'node:fs/promises'
import { loadConfig } from '../config.js'
import { MIGRATIONS_DIR, runMigrations, selectMigrationFiles } from './migrate.js'

describe('selectMigrationFiles', () => {
  it('keeps numbered .sql files in name order', () => {
    expect(selectMigrationFiles(['010_b.sql', 'README.md', '002_a.sql', 'x.sql', '001_init.sql'])).toEqual([
      '001_init.sql',
      '002_a.sql',
      '010_b.sql',
    ])
  })
})

// Opt-in with PYTHIA_DB_TESTS=1 in .env; needs `docker compose up -d postgres`.
// Connects to the `postgres` admin database and creates and drops its own
// throwaway database, so the real `pythia` database is never touched.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('runMigrations against Postgres', () => {
  const dbName = `pythia_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let migrationFiles: string[]

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    migrationFiles = selectMigrationFiles(await readdir(MIGRATIONS_DIR))
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    // dbName is generated above, never user input, so quoting it is safe.
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    // DROP DATABASE ... WITH (FORCE) in afterAll can kill a client that is
    // still closing (57P01); without a handler that is an unhandled error.
    pool.on('error', () => {})
    // Same for errors raised on an individual checked-out client.
    pool.on('connect', (client) => client.on('error', () => {}))
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('applies every migration on a clean database', async () => {
    expect(await runMigrations(pool)).toEqual({ applied: migrationFiles, skipped: [] })

    const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
    expect(ext.rowCount).toBe(1)

    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'activity',
      'chunks',
      'document_tombstones',
      'documents',
      'gemini_key',
      'gemini_usage',
      'llm_exclusions',
      'mcp_token',
      'profile',
      'recent_queries',
      'schema_migrations',
      'sessions',
      'sources',
    ])

    const indexes = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'chunks'")
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(['chunks_fts_idx', 'chunks_document_id_idx', 'chunks_embedding_hnsw_idx']),
    )

    const embedding = await pool.query<{ type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
    )
    expect(embedding.rows[0]?.type).toBe('vector(768)')
  })

  it('is a no-op when run again', async () => {
    expect(await runMigrations(pool)).toEqual({ applied: [], skipped: migrationFiles })
  })

  it('generates fts, applies defaults and cascades deletes', async () => {
    const source = await pool.query<{ id: string }>(
      "INSERT INTO sources (kind, name, root_path) VALUES ('obsidian', 'vault', '/vault') RETURNING id",
    )
    const sourceId = source.rows[0]!.id
    const doc = await pool.query<{ id: string; allow_llm: boolean }>(
      "INSERT INTO documents (source_id, path, title, content_hash) VALUES ($1, 'a.md', 'A', 'h') RETURNING id, allow_llm",
      [sourceId],
    )
    expect(doc.rows[0]!.allow_llm).toBe(true)
    await pool.query("INSERT INTO chunks (document_id, ordinal, content) VALUES ($1, 0, 'Running migrations twice')", [
      doc.rows[0]!.id,
    ])

    const hit = await pool.query("SELECT 1 FROM chunks WHERE fts @@ websearch_to_tsquery('english', 'migration')")
    expect(hit.rowCount).toBe(1)

    await pool.query('DELETE FROM sources WHERE id = $1', [sourceId])
    const left = await pool.query<{ n: string }>(
      'SELECT (SELECT count(*) FROM documents) + (SELECT count(*) FROM chunks) AS n',
    )
    expect(Number(left.rows[0]!.n)).toBe(0)
  })

  it('rejects an unknown source kind', async () => {
    await expect(pool.query("INSERT INTO sources (kind, name, root_path) VALUES ('email', 'x', '/x')")).rejects.toThrow(
      /check constraint/,
    )
  })
})

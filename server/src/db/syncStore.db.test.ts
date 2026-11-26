import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { EMBED_DIMENSIONS } from '../embed/ollama.js'
import { createSyncService, type SyncResponse, type SyncService } from '../sync/syncService.js'
import { createPgIndexStore, ensureSource } from './indexStore.js'
import { runMigrations } from './migrate.js'
import { createPgSyncStore } from './syncStore.js'
import { dropTestDatabase } from './testDatabase.js'

// T20 verify against real Postgres: the sequence, tombstones and source
// triggers from migrations/002_sync.sql, read through the sync service.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('cursor sync against Postgres', () => {
  const dbName = `pythia_sync_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let sync: SyncService
  const vector = Array.from({ length: EMBED_DIMENSIONS }, () => 0.01)

  const put = async (sourceId: number, path: string, content: string): Promise<void> => {
    await createPgIndexStore(pool).replaceDocument(
      sourceId,
      { path, title: path, language: null, contentHash: content, allowLlm: true, mtime: null },
      [
        { ordinal: 0, headingPath: path, startLine: 1, endLine: 1, content, embedding: vector },
        { ordinal: 1, headingPath: path, startLine: 2, endLine: 2, content: `${content} (more)`, embedding: vector },
      ],
      'nomic-embed-text',
    )
  }

  const drain = async (since: string, repos: string[] = [], limit?: number): Promise<SyncResponse> => {
    const all: SyncResponse = { cursor: since, hasMore: false, reset: false, documents: [], deleted: [] }
    for (;;) {
      const page = await sync.changes({ since: Number(all.cursor), repos, limit })
      all.cursor = page.cursor
      all.reset = all.reset || page.reset
      all.documents.push(...page.documents)
      all.deleted.push(...page.deleted)
      if (!page.hasMore) return all
    }
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
    sync = createSyncService({ store: createPgSyncStore(pool) })
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  it('syncs by cursor: first sync, edits, deletes, pinning and disabled sources', async () => {
    expect(await sync.changes({ since: 0, repos: [] })).toEqual({
      cursor: '0',
      hasMore: false,
      reset: false,
      documents: [],
      deleted: [],
    })

    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    const repo = await ensureSource(pool, 'repo', 'kitchen-app', '/repos/kitchen-app')
    await put(vault.id, 'A.md', 'Alpha')
    await put(vault.id, 'B.md', 'Bravo')
    await put(repo.id, 'src/cart.ts', 'export const cart = 1')
    const work = await pool.query<{ id: string }>(
      `INSERT INTO sources (kind, name, root_path) VALUES ('work', 'employer', '/work') RETURNING id`,
    )
    await put(Number(work.rows[0]?.id), 'memo.md', 'Employer memo')

    const first = await drain('0', [], 1)
    expect(first.documents.map((doc) => doc.path).sort()).toEqual(['A.md', 'B.md'])
    expect(first.documents.find((doc) => doc.path === 'A.md')?.content).toBe('Alpha\n\nAlpha (more)')
    expect(JSON.stringify(first)).not.toContain('Employer memo')
    expect(JSON.stringify(first)).not.toContain('export const cart')

    const pinned = await drain('0', ['kitchen-app'])
    expect(pinned.documents.map((doc) => doc.path).sort()).toEqual(['A.md', 'B.md', 'src/cart.ts'])

    // Nothing changed: an empty page with the same cursor.
    const idle = await sync.changes({ since: Number(first.cursor), repos: [] })
    expect(idle).toMatchObject({ cursor: first.cursor, documents: [], deleted: [] })

    const bId = first.documents.find((doc) => doc.path === 'B.md')?.id
    await put(vault.id, 'A.md', 'Alpha edited')
    await createPgIndexStore(pool).deleteDocuments(vault.id, ['B.md'])
    await put(vault.id, 'C.md', 'Charlie')
    const next = await drain(first.cursor)
    expect(next.documents.map((doc) => [doc.path, doc.content])).toEqual([
      ['A.md', 'Alpha edited\n\nAlpha edited (more)'],
      ['C.md', 'Charlie\n\nCharlie (more)'],
    ])
    expect(next.deleted).toEqual([bId])
    expect(Number(next.cursor)).toBeGreaterThan(Number(first.cursor))

    // Turning a source off makes its documents leave the client cache.
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [vault.id])
    const disabled = await drain(next.cursor)
    expect(disabled.documents).toEqual([])
    expect(disabled.deleted.length).toBe(2)

    // A cursor from a different (newer) database starts the client over.
    expect((await sync.changes({ since: Number(disabled.cursor) + 1000, repos: [] })).reset).toBe(true)
  })

  it('never lets a slow writer commit behind a cursor already handed out', async () => {
    const vault = await ensureSource(pool, 'obsidian', 'slow', '/slow')
    const start = (await sync.changes({ since: 0, repos: [] })).cursor
    const writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO documents (source_id, path, content_hash) VALUES ($1, 'Slow.md', 'x')`,
        [vault.id],
      )
      // The sync read waits for the open writer instead of skipping past it.
      const pending = sync.changes({ since: Number(start), repos: [] })
      const raced = await Promise.race([pending.then(() => 'sync'), new Promise((r) => setTimeout(() => r('timeout'), 300))])
      expect(raced).toBe('timeout')
      await writer.query('COMMIT')
      const page = await pending
      expect(page.documents.map((doc) => doc.path)).toEqual(['Slow.md'])
    } finally {
      writer.release()
    }
  })
})

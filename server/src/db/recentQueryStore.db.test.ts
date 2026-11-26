import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createRecentQueryService, MAX_RECENT_QUERIES, MAX_RECENT_QUERY_CHARS } from '../recent/recentQueryService.js'
import { runMigrations } from './migrate.js'
import { createPgRecentQueryStore } from './recentQueryStore.js'
import { dropTestDatabase } from './testDatabase.js'

// T34 verify against real Postgres: migrations/005_recent_queries.sql and the store.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('recent queries against Postgres', () => {
  const dbName = `pythia_recent_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM recent_queries')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  const service = () => createRecentQueryService(createPgRecentQueryStore(pool))

  it('drops the oldest when the 21st entry is recorded', async () => {
    for (let i = 1; i <= MAX_RECENT_QUERIES + 1; i += 1) await service().record('search', `q${i}`)
    const entries = await service().list('search')
    expect(entries).toHaveLength(MAX_RECENT_QUERIES)
    expect(entries[0]?.query).toBe(`q${MAX_RECENT_QUERIES + 1}`)
    expect(entries.at(-1)?.query).toBe('q2')
    const { rows } = await pool.query<{ n: string }>("SELECT count(*) AS n FROM recent_queries WHERE kind = 'search'")
    expect(rows[0]?.n).toBe(String(MAX_RECENT_QUERIES))
  })

  it('moves a repeat to the top as one row, with the newer filters', async () => {
    await service().record('search', 'one', { sources: ['obsidian'] })
    await service().record('search', 'two')
    await service().record('search', 'one', { repo: 'pythia' })
    const entries = await service().list('search')
    expect(entries.map((entry) => entry.query)).toEqual(['one', 'two'])
    expect(entries[0]?.filters).toEqual({ repo: 'pythia' })
  })

  it('does not record an empty query and stores a long one cut to 500 characters', async () => {
    await service().record('ask', '   ')
    expect(await service().list('ask')).toEqual([])
    await service().record('ask', 'x'.repeat(MAX_RECENT_QUERY_CHARS + 100))
    expect((await service().list('ask'))[0]?.query).toHaveLength(MAX_RECENT_QUERY_CHARS)
  })

  it('keeps the kinds apart, removes one entry and clears one kind', async () => {
    await service().record('search', 'same text')
    await service().record('ask', 'same text')
    const [searchEntry] = await service().list('search')
    expect(await service().remove(searchEntry?.id ?? 0)).toBe(true)
    expect(await service().remove(searchEntry?.id ?? 0)).toBe(false)
    expect(await service().list('search')).toEqual([])
    expect(await service().list('ask')).toHaveLength(1)
    await service().clear('ask')
    expect(await service().list('ask')).toEqual([])
  })

  it('refuses rows the table does not allow', async () => {
    await expect(pool.query("INSERT INTO recent_queries (kind, query) VALUES ('chat', 'x')")).rejects.toThrow()
    await expect(pool.query("INSERT INTO recent_queries (kind, query) VALUES ('search', '')")).rejects.toThrow()
  })
})

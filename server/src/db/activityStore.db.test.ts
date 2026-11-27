import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createActivityLog, MAX_ACTIVITY } from '../sync/activity.js'
import { createPgActivityStore } from './activityStore.js'
import { runMigrations } from './migrate.js'
import { dropTestDatabase } from './testDatabase.js'

// T42 verify against real Postgres: migrations/010_activity.sql and the store.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('activity against Postgres', () => {
  const dbName = `pythia_activity_test_${process.pid}_${Date.now()}`
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
    await pool.query('DELETE FROM activity')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  it('keeps only the newest 50 rows, trimmed with each insert', async () => {
    let clock = Date.UTC(2026, 10, 27)
    const activity = createActivityLog(createPgActivityStore(pool), { now: () => (clock += 1000) })
    for (let i = 1; i <= MAX_ACTIVITY + 10; i += 1) {
      await activity.record({ kind: 'repo_fetched', source: 'pythia', count: i })
      const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM activity')
      expect(Number(rows[0]?.n)).toBe(Math.min(i, MAX_ACTIVITY))
    }
    const events = await activity.list()
    expect(events).toHaveLength(MAX_ACTIVITY)
    expect(events[0]).toMatchObject({ kind: 'repo_fetched', source: 'pythia', count: MAX_ACTIVITY + 10, message: null })
    expect(events.at(-1)?.count).toBe(11)
    expect(events[0]?.at).toBeInstanceOf(Date)
    expect(typeof events[0]?.id).toBe('number')
  })

  it('stores a count-only secrets event and a short error reason', async () => {
    const activity = createActivityLog(createPgActivityStore(pool))
    await activity.record({ kind: 'secrets_blocked', source: 'obsidian', count: 3 })
    await activity.record({ kind: 'sync_error', source: 'pythia', message: 'fetch failed: GitError' })
    const events = await activity.list()
    expect(events.map((event) => [event.kind, event.source, event.count, event.message])).toEqual([
      ['sync_error', 'pythia', null, 'fetch failed: GitError'],
      ['secrets_blocked', 'obsidian', 3, null],
    ])
  })

  it('rejects an unknown kind at the database, and the log drops it without throwing', async () => {
    await expect(
      pool.query("INSERT INTO activity (kind, source) VALUES ('note_text', 'obsidian')"),
    ).rejects.toThrow()
    const errors: unknown[] = []
    const activity = createActivityLog(createPgActivityStore(pool), { onError: (error) => errors.push(error) })
    await activity.record({ kind: 'nope' as never, source: 'obsidian' })
    expect(errors).toHaveLength(1)
    expect(await activity.list()).toEqual([])
  })
})

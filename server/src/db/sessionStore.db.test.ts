import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { sha256Hex } from '../security/session.js'
import { createSessionManager } from '../security/sessionStore.js'
import { runMigrations } from './migrate.js'
import { createPgSessionStore } from './sessionStore.js'
import { dropTestDatabase } from './testDatabase.js'

// T36 verify against real Postgres: migrations/006_sessions.sql and the store.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('sessions against Postgres', () => {
  const dbName = `pythia_sessions_test_${process.pid}_${Date.now()}`
  const passwordHash = '$argon2id$' + 'v=19$m=1024,t=2,p=1$c2FsdA$a2V5'
  const day = 24 * 60 * 60 * 1000
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
    await pool.query('DELETE FROM sessions')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  // A new manager on a new store is what a restarted server builds.
  const manager = (hash = passwordHash) => createSessionManager({ store: createPgSessionStore(pool), passwordHash: hash })

  it('stores hashes only and keeps a session across a restart', async () => {
    const { token } = await manager().issue('Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) Safari/604.1')
    const { rows } = await pool.query<{ token_hash: string; password_tag: string; device_name: string }>(
      'SELECT token_hash, password_tag, device_name FROM sessions',
    )
    expect(rows).toEqual([{ token_hash: sha256Hex(token), password_tag: sha256Hex(passwordHash), device_name: 'iPhone · Safari' }])
    expect(await manager().verify(token)).not.toBeNull()
  })

  it('keeps a signed-out device signed out after a restart', async () => {
    const a = await manager().issue(undefined)
    const b = await manager().issue(undefined)
    expect(await manager().revokeDevice(a.session.id)).toBe(true)
    expect(await manager().verify(a.token)).toBeNull()
    expect(await manager().verify(b.token)).not.toBeNull()
    await manager().revokeAll()
    expect(await manager().verify(b.token)).toBeNull()
    expect(await manager().list()).toEqual([])
  })

  it('lists, renames and ends sessions when the password changes', async () => {
    const now = Date.now()
    const a = await manager().issue(undefined, now)
    await manager().issue(undefined, now + 1000)
    expect((await manager().rename(a.session.id, 'Desk PC', now))?.deviceName).toBe('Desk PC')
    expect((await manager().list(now + 1000)).map((s) => s.deviceName)).toEqual(['Unknown device', 'Desk PC'])
    expect(await manager(passwordHash + 'x').list(now + 1000)).toEqual([])
    expect(await manager(passwordHash + 'x').verify(a.token, now)).toBeNull()
  })

  it('writes last seen at most every 5 minutes', async () => {
    const now = Date.now()
    const { token } = await manager().issue(undefined, now)
    await manager().verify(token, now + 60_000)
    const seen = async () => (await pool.query<{ t: Date }>('SELECT last_seen_at AS t FROM sessions')).rows[0]?.t.getTime()
    expect(await seen()).toBe(now)
    await manager().verify(token, now + 6 * 60_000)
    expect(await seen()).toBe(now + 6 * 60_000)
  })

  it('deletes sessions that ended more than 30 days ago on the next login', async () => {
    const now = Date.now()
    const old = await manager().issue(undefined, now - 70 * day)
    const kept = await manager().issue(undefined, now - 10 * day)
    await manager().revoke(kept.token, now - 5 * day)
    await manager().issue(undefined, now)
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM sessions ORDER BY id')
    expect(rows.map((row) => Number(row.id))).not.toContain(old.session.id)
    expect(rows.map((row) => Number(row.id))).toContain(kept.session.id)
    expect(rows).toHaveLength(2)
  })

  it('refuses rows the table does not allow', async () => {
    const insert = (name: string, hash: string) =>
      pool.query("INSERT INTO sessions (token_hash, password_tag, device_name, expires_at) VALUES ($1, 't', $2, now())", [hash, name])
    await expect(insert('', 'a')).rejects.toThrow()
    await expect(insert('x'.repeat(81), 'b')).rejects.toThrow()
    await insert('ok', 'c')
    await expect(insert('ok', 'c')).rejects.toThrow()
  })
})

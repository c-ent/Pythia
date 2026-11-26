import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createProfileService, DEFAULT_PROFILE, type Profile } from '../profile/profileService.js'
import { runMigrations } from './migrate.js'
import { createPgProfileStore } from './profileStore.js'
import { dropTestDatabase } from './testDatabase.js'

// T30 verify against real Postgres: migrations/004_profile.sql and the store.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('profile against Postgres', () => {
  const dbName = `pythia_profile_test_${process.pid}_${Date.now()}`
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

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  it('starts with the default row', async () => {
    expect(await createPgProfileStore(pool).get()).toEqual(DEFAULT_PROFILE)
  })

  it('keeps a saved profile for a fresh load, as one row', async () => {
    const saved: Profile = {
      displayName: 'Cent',
      timeZone: 'Europe/London',
      vaultName: 'Main vault',
      theme: 'dark',
      openingMode: 'ask',
      notePreviews: false,
    }
    await createProfileService(createPgProfileStore(pool)).setProfile(saved)
    // A new store and service, as another device's request would get.
    expect(await createProfileService(createPgProfileStore(pool)).getProfile()).toEqual(saved)
    await createPgProfileStore(pool).save({ ...saved, displayName: 'C' })
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM profile')
    expect(rows[0]?.n).toBe('1')
    expect((await createPgProfileStore(pool).get())?.displayName).toBe('C')
  })

  it('refuses a second row and a theme outside the list', async () => {
    await expect(pool.query('INSERT INTO profile (id) VALUES (2)')).rejects.toThrow()
    await expect(pool.query("UPDATE profile SET theme = 'blue'")).rejects.toThrow()
  })

  it('re-running the migrations keeps the saved row', async () => {
    const before = await createPgProfileStore(pool).get()
    await runMigrations(pool)
    expect(await createPgProfileStore(pool).get()).toEqual(before)
  })
})

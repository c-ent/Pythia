import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { SECRETS_KEY_BYTES } from '../security/secretBox.js'
import { createGeminiSettings } from '../settings/geminiSettings.js'
import { createPgGeminiKeyStore, createPgGeminiUsageStore } from './geminiStore.js'
import { runMigrations } from './migrate.js'
import { dropTestDatabase } from './testDatabase.js'

// T39 verify against real Postgres: migrations/008_gemini_settings.sql and the stores.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('Gemini key and usage against Postgres', () => {
  const dbName = `pythia_gemini_test_${process.pid}_${Date.now()}`
  // Built by concatenation so no key-like literal is committed.
  const apiKey = 'AIza' + 'p'.repeat(31) + 'Pg01'
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
    await pool.query('DELETE FROM gemini_key')
    await pool.query('DELETE FROM gemini_usage')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  const service = (secretsKey: Buffer | null) =>
    createGeminiSettings({
      envKey: null,
      secretsKey,
      geminiModel: 'gemini-test',
      keys: createPgGeminiKeyStore(pool),
      usage: createPgGeminiUsageStore(pool),
    })

  it('stores no plain key, and opens it again after a restart with the same secrets key', async () => {
    const secretsKey = randomBytes(SECRETS_KEY_BYTES)
    await service(secretsKey).save(apiKey)

    const { rows } = await pool.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; last4: string }>(
      'SELECT ciphertext, iv, auth_tag, last4 FROM gemini_key',
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.last4).toBe('Pg01')
    const dump = JSON.stringify(rows) + row.ciphertext.toString('latin1')
    expect(dump).not.toContain(apiKey.slice(0, -4))
    expect(dump).not.toContain('AIza')

    expect(await service(secretsKey).status()).toMatchObject({ configured: true, source: 'settings', last4: 'Pg01' })
    // A wrong secrets key (say, after a restore) is no key, with a warning.
    expect(await service(randomBytes(SECRETS_KEY_BYTES)).status()).toMatchObject({
      configured: false,
      warning: 'undecryptable',
    })
  })

  it('keeps one row and removes it', async () => {
    const secretsKey = randomBytes(SECRETS_KEY_BYTES)
    await service(secretsKey).save(apiKey)
    await service(secretsKey).save('AIza' + 'r'.repeat(31) + 'Pg02')
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM gemini_key')
    expect(rows[0]?.n).toBe('1')
    expect(await service(secretsKey).status()).toMatchObject({ last4: 'Pg02' })
    await service(secretsKey).remove()
    expect(await service(secretsKey).status()).toMatchObject({ configured: false, savedAt: null })
  })

  it('counts requests per day', async () => {
    const usage = createPgGeminiUsageStore(pool)
    expect(await usage.get('2026-11-26')).toBe(0)
    await usage.increment('2026-11-26')
    await usage.increment('2026-11-26')
    await usage.increment('2026-11-27')
    expect(await usage.get('2026-11-26')).toBe(2)
    expect(await usage.get('2026-11-27')).toBe(1)
  })

  it('refuses rows the table does not allow', async () => {
    const insert = (iv: Buffer, tag: Buffer, last4: string, id = true) =>
      pool.query('INSERT INTO gemini_key (id, ciphertext, iv, auth_tag, last4) VALUES ($1, $2, $3, $4, $5)', [
        id,
        Buffer.from('x'),
        iv,
        tag,
        last4,
      ])
    await expect(insert(Buffer.alloc(8), Buffer.alloc(16), 'abcd')).rejects.toThrow()
    await expect(insert(Buffer.alloc(12), Buffer.alloc(8), 'abcd')).rejects.toThrow()
    await expect(insert(Buffer.alloc(12), Buffer.alloc(16), 'abc')).rejects.toThrow()
    await expect(insert(Buffer.alloc(12), Buffer.alloc(16), 'abcd', false)).rejects.toThrow()
  })
})

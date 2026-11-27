import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createMcpTokenService } from '../mcp/mcpToken.js'
import { sha256Hex } from '../security/session.js'
import { createPgMcpTokenStore } from './mcpTokenStore.js'
import { runMigrations } from './migrate.js'
import { dropTestDatabase } from './testDatabase.js'

// T37 verify against real Postgres: migrations/007_mcp_token.sql and the store.
// Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('MCP token against Postgres', () => {
  const dbName = `pythia_mcp_token_test_${process.pid}_${Date.now()}`
  const envToken = 'env-mcp-token-' + 'e'.repeat(30)
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
    await pool.query('DELETE FROM mcp_token')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  // A new service on a new store is what a restarted server builds.
  const service = () => createMcpTokenService({ envToken, store: createPgMcpTokenStore(pool) })

  it('uses .env while the table is empty, then only the rotated token, also after a restart', async () => {
    expect(await service().verify(envToken)).toBe(true)
    const { token, last4 } = await service().rotate()
    expect(await service().verify(envToken)).toBe(false)
    expect(await service().verify(token)).toBe(true)
    expect(await service().status()).toMatchObject({ source: 'database', last4 })

    const { rows } = await pool.query<{ token_hash: string; last4: string }>('SELECT token_hash, last4 FROM mcp_token')
    expect(rows).toEqual([{ token_hash: sha256Hex(token), last4 }])
  })

  it('keeps one row across rotations', async () => {
    const first = await service().rotate()
    const second = await service().rotate()
    expect(await service().verify(first.token)).toBe(false)
    expect(await service().verify(second.token)).toBe(true)
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM mcp_token')
    expect(rows[0]?.n).toBe('1')
  })

  it('refuses rows the table does not allow', async () => {
    await expect(pool.query("INSERT INTO mcp_token (id, token_hash, last4) VALUES (false, 'h', 'abcd')")).rejects.toThrow()
    await expect(pool.query("INSERT INTO mcp_token (token_hash, last4) VALUES ('h', 'abc')")).rejects.toThrow()
    await pool.query("INSERT INTO mcp_token (token_hash, last4) VALUES ('h', 'abcd')")
    await expect(pool.query("INSERT INTO mcp_token (token_hash, last4) VALUES ('h2', 'wxyz')")).rejects.toThrow()
  })
})

import { EventEmitter } from 'node:events'
import pg from 'pg'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgActivityStore } from './activityStore.js'
import { createActivityLog } from '../sync/activity.js'
import type { DbConfig } from '../config.js'
import { createPool } from './pool.js'

// T53: a dropped Postgres connection never crashes the app. A fake client
// stands in for pg's, so the test needs no Postgres; it behaves like pg's
// `Client` when its socket dies: pending queries reject, `_queryable` turns
// false and the client emits `error`.

class ConnectionTerminated extends Error {
  override name = 'ConnectionTerminated'
}

const SECRET_DETAIL = 'terminating connection: host db.internal user pythia'

type Callback = (error: Error | null, result?: unknown) => void

class FakeClient extends EventEmitter {
  static instances: FakeClient[] = []
  /** A query whose text starts with this kills the connection while it runs. */
  static failOn: string | null = null

  _queryable = true
  _ending = false
  readonly queries: string[] = []

  constructor() {
    super()
    FakeClient.instances.push(this)
  }

  connect(callback: (error?: Error) => void): void {
    setImmediate(() => callback())
  }

  query(text: string, values?: unknown, callback?: Callback): Promise<unknown> | undefined {
    if (typeof values === 'function') callback = values as Callback
    this.queries.push(text)
    const result = new Promise<unknown>((resolve, reject) => {
      setImmediate(() => {
        if (FakeClient.failOn !== null && text.startsWith(FakeClient.failOn)) {
          const error = new ConnectionTerminated(SECRET_DETAIL)
          this._queryable = false
          reject(error)
          this.emit('error', error)
          return
        }
        if (!this._queryable) return reject(new Error('Client has encountered a connection error and is not queryable'))
        resolve({ rows: [], rowCount: 0 })
      })
    })
    if (callback === undefined) return result
    result.then(
      (value) => callback(null, value),
      (error: Error) => callback(error),
    )
    return undefined
  }

  end(callback?: () => void): Promise<void> | undefined {
    this._ending = true
    this._queryable = false
    if (callback === undefined) return Promise.resolve()
    setImmediate(callback)
    return undefined
  }
}

const fakeSecret = ['not', 'used'].join('-')
const db: DbConfig = { host: '127.0.0.1', port: 5433, user: 'pythia', database: 'pythia', password: fakeSecret }
const Client = FakeClient as unknown as pg.PoolConfig['Client']

const pools: pg.Pool[] = []
afterEach(async () => {
  FakeClient.failOn = null
  FakeClient.instances = []
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
})

function setup() {
  const logs: string[] = []
  const pool = createPool(db, { Client, log: (message) => logs.push(message) })
  pools.push(pool)
  return { pool, logs }
}

describe('createPool', () => {
  it('without the handlers, an idle client losing its connection throws (what crashed the app)', async () => {
    const pool = new pg.Pool({ ...db, Client })
    pools.push(pool)
    await pool.query('SELECT 1')
    expect(() => FakeClient.instances[0]!.emit('error', new ConnectionTerminated(SECRET_DETAIL))).toThrow(ConnectionTerminated)
  })

  it('logs an error on an idle client by class only, keeps running, and reconnects on the next query', async () => {
    const { pool, logs } = setup()
    await pool.query('SELECT 1')
    expect(pool.idleCount).toBe(1)

    expect(() => FakeClient.instances[0]!.emit('error', new ConnectionTerminated(SECRET_DETAIL))).not.toThrow()
    expect(logs).toEqual(['postgres: connection lost: ConnectionTerminated'])
    expect(logs.join('\n')).not.toContain('db.internal')
    expect(pool.totalCount).toBe(0)

    await expect(pool.query('SELECT 1')).resolves.toBeDefined()
    expect(FakeClient.instances).toHaveLength(2)
    expect(FakeClient.instances[1]!.queries).toEqual(['SELECT 1'])
  })

  it('handles a connection lost during a checked-out transaction (the activity write on 2026-11-27)', async () => {
    const { pool, logs } = setup()
    const failures: unknown[] = []
    const activity = createActivityLog(createPgActivityStore(pool), { onError: (error) => failures.push(error) })

    FakeClient.failOn = 'INSERT INTO activity'
    // Never throws: the activity log drops a failed write after logging it.
    await expect(activity.record({ kind: 'repos_fetched', source: 'github', count: 1 })).resolves.toBeUndefined()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(ConnectionTerminated)
    expect(logs).toEqual(['postgres: connection lost: ConnectionTerminated'])
    // The dead client went back to the pool unqueryable and was dropped, not reused.
    expect(pool.totalCount).toBe(0)

    FakeClient.failOn = null
    await activity.record({ kind: 'repos_fetched', source: 'github', count: 2 })
    expect(failures).toHaveLength(1)
    expect(FakeClient.instances).toHaveLength(2)
    expect(FakeClient.instances[1]!.queries[0]).toBe('BEGIN')
  })
})

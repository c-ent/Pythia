import pg from 'pg'
import type { DbConfig } from '../config.js'

/**
 * The one way to open the Postgres pool (T53). Without these handlers a
 * dropped connection crashes the process: `pg` emits `error` on the client
 * whose socket died, and an `error` event nobody listens to is thrown.
 *
 * - A client checked out of the pool (a transaction, like the activity write
 *   that failed during the 2026-11-27 host restart) has no pool listener while
 *   it is checked out, so every client gets its own listener on `connect`. Its
 *   query still rejects, the caller's `catch` handles that, and `release()`
 *   drops the dead client because it is no longer queryable.
 * - An idle client's error is re-emitted on the pool after the pool has
 *   already removed that client; the next query opens a new connection.
 *
 * Only the error class is logged: messages can quote SQL or connection details.
 */
export interface PoolOptions {
  log?: (message: string) => void
  /** Injected for tests: a fake client class, so no Postgres is needed. */
  Client?: pg.PoolConfig['Client']
}

const errorName = (error: unknown): string => (error instanceof Error && error.name !== '' ? error.name : 'unknown')

export function createPool(config: DbConfig, options: PoolOptions = {}): pg.Pool {
  const log = options.log ?? ((message: string) => console.error(message))
  const pool = new pg.Pool(options.Client === undefined ? config : { ...config, Client: options.Client })
  pool.on('connect', (client) => {
    client.on('error', (error) => log(`postgres: connection lost: ${errorName(error)}`))
  })
  // The client listener above has already logged this error; this listener
  // only keeps the pool's re-emit from crashing the process.
  pool.on('error', () => {})
  return pool
}

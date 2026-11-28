import type { Pool, PoolClient } from 'pg'

/** Base visibility predicate: enabled source, never `work`, not excluded. */
export const visibleSource = (s = 's', d = 'd'): string =>
  `${s}.enabled AND ${s}.kind <> 'work' AND NOT ${d}.excluded`

/** Visibility + optional `sources` ($N::text[]) and `repo` ($M::text) filter. */
export const sourceFilterSql = (sourcesParam: number, repoParam: number, s = 's', d = 'd'): string =>
  `${visibleSource(s, d)}
  AND ($${sourcesParam}::text[] IS NULL OR ${s}.kind = ANY ($${sourcesParam}::text[]))
  AND ($${repoParam}::text IS NULL OR (${s}.kind = 'repo' AND ${s}.name = $${repoParam}::text))`

export const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`

/**
 * Runs `fn` inside a transaction configured with `hnsw.ef_search` and
 * `hnsw.iterative_scan = 'strict_order'` so filtered HNSW queries keep
 * reading the index until their LIMIT is satisfied.
 */
export async function withHnswScan<T>(pool: Pool, efSearch: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const clamped = String(Math.min(1000, Math.max(100, efSearch)))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      await client.query(
        `SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true)`,
        [clamped],
      )
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    client.release()
  }
}

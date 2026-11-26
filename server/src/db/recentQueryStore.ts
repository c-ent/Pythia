import type { Pool } from 'pg'
import {
  parseRecentQueryFilters,
  type RecentQuery,
  type RecentQueryKind,
  type RecentQueryStore,
} from '../recent/recentQueryService.js'

interface RecentQueryRow {
  id: string
  kind: RecentQueryKind
  query: string
  filters: unknown
  used_at: Date
}

/** The `recent_queries` table from migrations/005_recent_queries.sql. */
export function createPgRecentQueryStore(pool: Pool): RecentQueryStore {
  return {
    async record(kind, query, filters, keep) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // clock_timestamp(), not now(): two records in quick succession must still sort apart.
        await client.query(
          `INSERT INTO recent_queries (kind, query, filters, used_at)
           VALUES ($1, $2, $3::jsonb, clock_timestamp())
           ON CONFLICT (kind, query) DO UPDATE SET filters = EXCLUDED.filters, used_at = EXCLUDED.used_at`,
          [kind, query, JSON.stringify(filters)],
        )
        await client.query(
          `DELETE FROM recent_queries
           WHERE kind = $1
             AND id NOT IN (SELECT id FROM recent_queries WHERE kind = $1 ORDER BY used_at DESC, id DESC LIMIT $2)`,
          [kind, keep],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    async list(kind, limit) {
      const { rows } = await pool.query<RecentQueryRow>(
        `SELECT id, kind, query, filters, used_at FROM recent_queries
         WHERE kind = $1 ORDER BY used_at DESC, id DESC LIMIT $2`,
        [kind, limit],
      )
      return rows.map(
        (row): RecentQuery => ({
          id: Number(row.id),
          kind: row.kind,
          query: row.query,
          filters: parseRecentQueryFilters(row.filters),
          at: row.used_at,
        }),
      )
    },

    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM recent_queries WHERE id = $1', [id])
      return (rowCount ?? 0) > 0
    },

    async clear(kind) {
      await pool.query('DELETE FROM recent_queries WHERE kind = $1', [kind])
    },
  }
}

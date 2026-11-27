import type { Pool } from 'pg'
import type { ActivityEvent, ActivityKind, ActivityStore } from '../sync/activity.js'

interface ActivityRow {
  id: string
  at: Date
  kind: ActivityKind
  source: string | null
  count: number | null
  message: string | null
}

/** The `activity` table from migrations/010_activity.sql. */
export function createPgActivityStore(pool: Pool): ActivityStore {
  return {
    async record(event, keep) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('INSERT INTO activity (at, kind, source, count, message) VALUES ($1, $2, $3, $4, $5)', [
          event.at,
          event.kind,
          event.source,
          event.count,
          event.message,
        ])
        await client.query(
          'DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT $1)',
          [keep],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    },

    async list(limit) {
      const { rows } = await pool.query<ActivityRow>(
        'SELECT id, at, kind, source, count, message FROM activity ORDER BY at DESC, id DESC LIMIT $1',
        [limit],
      )
      return rows.map(
        (row): ActivityEvent => ({
          id: Number(row.id),
          at: row.at,
          kind: row.kind,
          source: row.source,
          count: row.count,
          message: row.message,
        }),
      )
    },
  }
}

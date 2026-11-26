import type { Pool } from 'pg'
import type { SearchableKind } from './searchStore.js'

/** Advisory lock shared with the triggers in `migrations/002_sync.sql`. */
export const SYNC_LOCK_ID = 7_294_732

export interface SyncDocumentRow {
  seq: number
  id: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  language: string | null
  allowLlm: boolean
  mtime: Date | null
  updatedAt: Date
  /** Chunk contents in ordinal order. */
  chunks: string[]
}

/** One change after a cursor: a document to keep, or an id the client must drop. */
export type SyncRow = { type: 'upsert'; doc: SyncDocumentRow } | { type: 'delete'; seq: number; id: number }

export interface SyncChangesParams {
  /** Exclusive lower bound (the client's cursor). */
  after: number
  /** Inclusive upper bound (the high-water mark). */
  upTo: number
  /** Repo sources whose files are synced (pinned repos); other repo files count as removed. */
  repos: readonly string[]
  limit: number
}

/** What the sync service needs from the database. Tests use an in-memory version. */
export interface SyncStore {
  /** Highest sequence value whose transaction has committed; 0 before any change. */
  highWater(): Promise<number>
  /** Changes in `(after, upTo]`, in sequence order, at most `limit`. */
  changes(params: SyncChangesParams): Promise<SyncRow[]>
}

const CHANGES_SQL = `
SELECT * FROM (
  SELECT d.sync_seq AS seq, d.id,
         (s.enabled AND s.kind <> 'work' AND (s.kind <> 'repo' OR s.name = ANY ($3::text[]))) AS visible,
         s.kind, s.name AS source_name, d.path, d.title, d.language, d.allow_llm, d.mtime, d.updated_at
  FROM documents d JOIN sources s ON s.id = d.source_id
  WHERE d.sync_seq > $1 AND d.sync_seq <= $2
  UNION ALL
  SELECT t.sync_seq, t.document_id, false,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, NULL::timestamptz
  FROM document_tombstones t
  WHERE t.sync_seq > $1 AND t.sync_seq <= $2
) c
ORDER BY seq
LIMIT $4`

interface ChangeRow {
  seq: string
  id: string
  visible: boolean
  kind: SearchableKind | null
  source_name: string | null
  path: string | null
  title: string | null
  language: string | null
  allow_llm: boolean | null
  mtime: Date | null
  updated_at: Date | null
}

export function createPgSyncStore(pool: Pool): SyncStore {
  return {
    async highWater() {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Waits for every writer that has drawn a value to commit or roll back.
          await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_ID])
          const { rows } = await client.query<{ last_value: string; is_called: boolean }>(
            'SELECT last_value, is_called FROM sync_seq',
          )
          await client.query('COMMIT')
          const row = rows[0]
          return row === undefined || !row.is_called ? 0 : Number(row.last_value)
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async changes(params) {
      const client = await pool.connect()
      try {
        // One snapshot for the change list and the chunk text.
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try {
          const { rows } = await client.query<ChangeRow>(CHANGES_SQL, [params.after, params.upTo, [...params.repos], params.limit])
          const visibleIds = rows.filter((row) => row.visible).map((row) => row.id)
          const chunkRows =
            visibleIds.length === 0
              ? []
              : (
                  await client.query<{ document_id: string; chunks: string[] }>(
                    `SELECT document_id, array_agg(content ORDER BY ordinal) AS chunks
                     FROM chunks WHERE document_id = ANY ($1::bigint[])
                     GROUP BY document_id`,
                    [visibleIds],
                  )
                ).rows
          await client.query('COMMIT')
          const chunks = new Map(chunkRows.map((row) => [row.document_id, row.chunks]))
          return rows.map((row): SyncRow => {
            const seq = Number(row.seq)
            const id = Number(row.id)
            if (!row.visible) return { type: 'delete', seq, id }
            return {
              type: 'upsert',
              doc: {
                seq,
                id,
                sourceKind: row.kind as SearchableKind,
                sourceName: row.source_name ?? '',
                path: row.path ?? '',
                title: row.title ?? '',
                language: row.language,
                allowLlm: row.allow_llm ?? false,
                mtime: row.mtime,
                updatedAt: row.updated_at ?? new Date(0),
                chunks: chunks.get(row.id) ?? [],
              },
            }
          })
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

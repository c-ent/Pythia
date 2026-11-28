import type { Pool } from 'pg'
import type { LinkKind } from '../ingest/links.js'
import { NEIGHBOUR_CUTOFF } from './neighbourStore.js'
import type { SearchableKind } from './searchStore.js'

/** Advisory lock shared with the triggers in `migrations/002_sync.sql`. */
export const SYNC_LOCK_ID = 7_294_732

/** One entry of a document's stored neighbour list (R20, T72). */
export interface SyncNeighbour {
  id: number
  /** Cosine similarity of the two document vectors. */
  score: number
}

/** One `links` row (R20, T72), as stored: targets are resolved on the device, like on the server. */
export interface SyncLink {
  kind: LinkKind
  target: string
  heading: string | null
  display: string | null
}

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
  /** Has a map vector (R20): only map documents have neighbours or appear in the knowledge map. */
  inMap: boolean
  /** Its stored neighbour list, nearest first, at or above the cut-off. */
  neighbours: SyncNeighbour[]
  /** Its link, tag, label and alias rows in stored order (Obsidian and Keep notes only). */
  links: SyncLink[]
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
         (s.enabled AND s.kind <> 'work' AND NOT d.excluded AND (s.kind <> 'repo' OR s.name = ANY ($3::text[]))) AS visible,
         s.kind, s.name AS source_name, d.path, d.title, d.language, d.allow_llm, d.mtime, d.updated_at,
         (v.document_id IS NOT NULL) AS in_map
  FROM documents d
  JOIN sources s ON s.id = d.source_id
  LEFT JOIN document_vectors v ON v.document_id = d.id
  WHERE d.sync_seq > $1 AND d.sync_seq <= $2
  UNION ALL
  SELECT t.sync_seq, t.document_id, false,
         NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::boolean, NULL::timestamptz, NULL::timestamptz,
         NULL::boolean
  FROM document_tombstones t
  WHERE t.sync_seq > $1 AND t.sync_seq <= $2
) c
ORDER BY seq
LIMIT $4`

// The stored list as the Related panel reads it without filters (neighbourStore.ts):
// same model as the document's vector, at or above the cut-off, by rank.
const NEIGHBOURS_SQL = `
SELECT n.document_id,
       array_agg(n.neighbour_id ORDER BY n.rank) AS ids,
       array_agg(n.score::float8 ORDER BY n.rank) AS scores
FROM document_neighbours n
JOIN document_vectors v ON v.document_id = n.document_id AND v.embed_model = n.embed_model
WHERE n.document_id = ANY ($1::bigint[]) AND n.score >= $2
GROUP BY n.document_id`

const LINKS_SQL = `
SELECT document_id,
       json_agg(json_build_object('kind', kind, 'target', target, 'heading', heading, 'display', display) ORDER BY ordinal) AS links
FROM links
WHERE document_id = ANY ($1::bigint[])
GROUP BY document_id`

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
  in_map: boolean | null
}

export interface PgSyncStoreOptions {
  /** Lowest neighbour score sent; defaults to the Related panel's cut-off. */
  cutoff?: number
}

export function createPgSyncStore(pool: Pool, options: PgSyncStoreOptions = {}): SyncStore {
  const cutoff = options.cutoff ?? NEIGHBOUR_CUTOFF
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
        // One snapshot for the change list, the chunk text and the map rows.
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        try {
          const { rows } = await client.query<ChangeRow>(CHANGES_SQL, [params.after, params.upTo, [...params.repos], params.limit])
          const visibleIds = rows.filter((row) => row.visible).map((row) => row.id)
          const none = visibleIds.length === 0
          const chunkRows = none
            ? []
            : (
                await client.query<{ document_id: string; chunks: string[] }>(
                  `SELECT document_id, array_agg(content ORDER BY ordinal) AS chunks
                   FROM chunks WHERE document_id = ANY ($1::bigint[])
                   GROUP BY document_id`,
                  [visibleIds],
                )
              ).rows
          const neighbourRows = none
            ? []
            : (
                await client.query<{ document_id: string; ids: string[]; scores: number[] }>(NEIGHBOURS_SQL, [
                  visibleIds,
                  cutoff,
                ])
              ).rows
          const linkRows = none
            ? []
            : (await client.query<{ document_id: string; links: SyncLink[] }>(LINKS_SQL, [visibleIds])).rows
          await client.query('COMMIT')
          const chunks = new Map(chunkRows.map((row) => [row.document_id, row.chunks]))
          const neighbours = new Map(
            neighbourRows.map((row) => [
              row.document_id,
              row.ids.map((id, i): SyncNeighbour => ({ id: Number(id), score: row.scores[i] ?? 0 })),
            ]),
          )
          const links = new Map(linkRows.map((row) => [row.document_id, row.links]))
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
                inMap: row.in_map ?? false,
                neighbours: neighbours.get(row.id) ?? [],
                links: links.get(row.id) ?? [],
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

import type { Pool } from 'pg'
import type { SearchableKind, SearchFilters } from './searchStore.js'

/**
 * `document_neighbours` (R20, T66): each map document's top neighbours by
 * cosine similarity of the `document_vectors` means, above a cut-off, within
 * one `embed_model` (D5). Written after index rounds by `refreshNeighbours`,
 * read by the Related panel through `createPgRelatedStore`. No embedder call
 * anywhere: everything is computed from stored vectors.
 */

/** Neighbours kept per map document (R20). */
export const MAX_NEIGHBOURS = 8
/** Lowest cosine similarity that counts as a neighbour (R20: starts at 0.6, tuned in T67b). */
export const NEIGHBOUR_CUTOFF = 0.6

export interface RefreshOptions {
  limit?: number
  cutoff?: number
  /** Logs a document whose refresh failed, by error class only. */
  log?: (message: string) => void
}

export interface RefreshResult {
  /** Documents whose list was recomputed. */
  refreshed: number
  /** Documents whose refresh failed; they stay due and are retried next round. */
  failed: number
}

// The bare distance in ORDER BY lets the HNSW index serve the scan; iterative
// scans keep reading it until LIMIT rows pass the model filter.
const NEAREST_SQL = `
  SELECT v.document_id, (1 - (v.embedding <=> $2::vector))::float8 AS score
  FROM document_vectors v
  WHERE v.embed_model = $3 AND v.document_id <> $1
  ORDER BY v.embedding <=> $2::vector
  LIMIT $4`

/** Same neighbours in the same order with the same scores (stored as `real`, so compared loosely). */
function sameList(
  before: readonly { neighbour_id: string; score: number }[],
  after: readonly { document_id: string; score: number }[],
): boolean {
  return (
    before.length === after.length &&
    before.every((row, i) => {
      const next = after[i]
      return next !== undefined && row.neighbour_id === next.document_id && Math.abs(row.score - next.score) < 1e-5
    })
  )
}

const HNSW_SETTINGS =`SELECT set_config('hnsw.ef_search', '100', true), set_config('hnsw.iterative_scan', 'strict_order', true)`

/**
 * Recomputes one document's list. Returns the new neighbour ids, or null when
 * the document has no vector any more (deleted or left the map meanwhile).
 */
async function refreshOne(pool: Pool, documentId: string, limit: number, cutoff: number): Promise<string[] | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    try {
      // `updated_at` as text: a JS Date drops the microseconds, and the
      // compare-and-set below needs the exact value.
      const own = await client.query<{ embedding: string; embed_model: string; updated_at: string }>(
        `SELECT embedding::text AS embedding, embed_model, updated_at::text AS updated_at
         FROM document_vectors WHERE document_id = $1`,
        [documentId],
      )
      const me = own.rows[0]
      if (me === undefined) {
        await client.query('COMMIT')
        return null
      }
      await client.query(HNSW_SETTINGS)
      const nearest = await client.query<{ document_id: string; score: number }>(NEAREST_SQL, [
        documentId,
        me.embedding,
        me.embed_model,
        limit,
      ])
      // Rows come nearest first, so the cut-off only trims the tail.
      const kept = nearest.rows.filter((row) => row.score >= cutoff)
      const before = await client.query<{ neighbour_id: string; score: number }>(
        `SELECT neighbour_id, score::float8 AS score FROM document_neighbours
         WHERE document_id = $1 AND embed_model = $2 ORDER BY rank`,
        [documentId, me.embed_model],
      )
      await client.query('DELETE FROM document_neighbours WHERE document_id = $1', [documentId])
      if (kept.length > 0) {
        await client.query(
          `INSERT INTO document_neighbours (document_id, neighbour_id, rank, score, embed_model)
           SELECT $1, t.neighbour_id, t.rank, t.score, $5
           FROM unnest($2::bigint[], $3::int[], $4::float8[]) AS t (neighbour_id, rank, score)`,
          [
            documentId,
            kept.map((row) => row.document_id),
            kept.map((_, i) => i + 1),
            kept.map((row) => row.score),
            me.embed_model,
          ],
        )
      }
      // A changed list is a change the offline copy must get (R11, T72): touching
      // the document gives it a new sync sequence value (migrations/002_sync.sql).
      if (!sameList(before.rows, kept)) {
        await client.query('UPDATE documents SET sync_seq = sync_seq WHERE id = $1', [documentId])
      }
      // Last, because deleting the old rows above marks this document due
      // again (the document_neighbours_deleted trigger). A vector rewritten
      // since it was read keeps the document due for the next round.
      await client.query(
        'UPDATE document_vectors SET neighbours_at = updated_at WHERE document_id = $1 AND updated_at = $2',
        [documentId, me.updated_at],
      )
      await client.query('COMMIT')
      return kept.map((row) => row.document_id)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    client.release()
  }
}

/**
 * Brings `document_neighbours` up to date after an index round (R20):
 * - changed documents: a vector written since its list was computed, or never
 *   computed, or a list that lost a row because the neighbour went;
 * - the documents that listed a changed document;
 * - the documents a changed document now lists, so a new or edited document
 *   can enter their lists too (similarity is symmetric).
 * One document per transaction; a failure is logged and the document stays
 * due, so the next round retries it.
 */
export async function refreshNeighbours(pool: Pool, options: RefreshOptions = {}): Promise<RefreshResult> {
  const limit = options.limit ?? MAX_NEIGHBOURS
  const cutoff = options.cutoff ?? NEIGHBOUR_CUTOFF
  const log = options.log ?? ((message: string) => console.error(message))

  const due = await pool.query<{ document_id: string }>(
    `SELECT document_id FROM document_vectors
     WHERE neighbours_at IS NULL OR neighbours_at < updated_at
     ORDER BY document_id`,
  )
  const changed = due.rows.map((row) => row.document_id)
  if (changed.length === 0) return { refreshed: 0, failed: 0 }

  const listed = await pool.query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM document_neighbours
     WHERE neighbour_id = ANY ($1::bigint[]) AND NOT (document_id = ANY ($1::bigint[]))
     ORDER BY document_id`,
    [changed],
  )

  const done = new Set<string>()
  const result: RefreshResult = { refreshed: 0, failed: 0 }
  const run = async (id: string): Promise<string[] | null> => {
    if (done.has(id)) return null
    done.add(id)
    try {
      const neighbours = await refreshOne(pool, id, limit, cutoff)
      if (neighbours !== null) result.refreshed++
      return neighbours
    } catch (error) {
      result.failed++
      log(`map: neighbour refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
      return null
    }
  }

  const reverse = new Set<string>()
  for (const id of changed) {
    for (const neighbour of (await run(id)) ?? []) reverse.add(neighbour)
  }
  for (const row of listed.rows) await run(row.document_id)
  for (const id of reverse) await run(id)
  return result
}

export interface RelatedParams {
  documentId: number
  filters: SearchFilters
  limit: number
  cutoff: number
}

export interface RelatedHit {
  documentId: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  allowLlm: boolean
  /** Cosine similarity of the two document vectors. */
  score: number
  /** The neighbour's chunk closest to the opened document; null if it has none in this model. */
  passage: {
    chunkId: number
    headingPath: string
    startLine: number | null
    endLine: number | null
    content: string
  } | null
}

export interface RelatedLookup {
  /** False when the document is not a map document (no vector): it has no neighbours. */
  inMap: boolean
  hits: RelatedHit[]
}

/** What the related service needs from the database. Tests use an in-memory version. */
export interface RelatedStore {
  /** Null when the document does not exist or is not visible (work, switched-off source). */
  related(params: RelatedParams): Promise<RelatedLookup | null>
}

// Same visibility and filters as hybrid search (searchStore.ts). Uses $5
// (kinds or null) and $6 (repo name or null).
const NEIGHBOUR_FILTER = `s.enabled AND s.kind <> 'work'
  AND ($5::text[] IS NULL OR s.kind = ANY ($5::text[]))
  AND ($6::text IS NULL OR (s.kind = 'repo' AND s.name = $6::text))`

// Without filters the stored list is read as it is.
const STORED_RANKED = `
  SELECT n.neighbour_id AS id, n.score::float8 AS score
  FROM document_neighbours n
  JOIN document_vectors v ON v.document_id = n.neighbour_id AND v.embed_model = n.embed_model
  JOIN documents d ON d.id = n.neighbour_id
  JOIN sources s ON s.id = d.source_id
  WHERE n.document_id = $1 AND n.embed_model = $3 AND n.score >= $7 AND ${NEIGHBOUR_FILTER}
  ORDER BY n.rank
  LIMIT $4`

// With a source or repo filter the stored top 8 could hold none of the wanted
// sources, so the ranking runs on the stored vectors with the filter inside
// it (R4, R20): still no embedder call.
const FILTERED_RANKED = `
  SELECT id, score FROM (
    SELECT v.document_id AS id, (1 - (v.embedding <=> $2::vector))::float8 AS score
    FROM document_vectors v
    JOIN documents d ON d.id = v.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE v.embed_model = $3 AND v.document_id <> $1 AND ${NEIGHBOUR_FILTER}
    ORDER BY v.embedding <=> $2::vector
    LIMIT $4
  ) t
  WHERE score >= $7`

// `+ 0` keeps the planner off the global chunks HNSW index here: the
// neighbour's few chunks come from chunks_document_id_idx and are sorted.
const relatedSql = (ranked: string): string => `
WITH ranked AS (${ranked})
SELECT r.id, r.score, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm,
       p.id AS chunk_id, p.heading_path, p.start_line, p.end_line, p.content
FROM ranked r
JOIN documents d ON d.id = r.id
JOIN sources s ON s.id = d.source_id
LEFT JOIN LATERAL (
  SELECT c.id, c.heading_path, c.start_line, c.end_line, c.content
  FROM chunks c
  WHERE c.document_id = r.id AND c.embedding IS NOT NULL AND c.embed_model = $3
  ORDER BY (c.embedding <=> $2::vector) + 0, c.ordinal
  LIMIT 1
) p ON true
ORDER BY r.score DESC, r.id`

interface RelatedRow {
  id: string
  score: number
  kind: SearchableKind
  source_name: string
  path: string
  title: string
  allow_llm: boolean
  chunk_id: string | null
  heading_path: string | null
  start_line: number | null
  end_line: number | null
  content: string | null
}

export function createPgRelatedStore(pool: Pool): RelatedStore {
  return {
    async related(params) {
      const own = await pool.query<{ embedding: string | null; embed_model: string | null }>(
        `SELECT v.embedding::text AS embedding, v.embed_model
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         LEFT JOIN document_vectors v ON v.document_id = d.id
         WHERE d.id = $1 AND s.enabled AND s.kind <> 'work'`,
        [params.documentId],
      )
      const me = own.rows[0]
      if (me === undefined) return null
      if (me.embedding === null || me.embed_model === null) return { inMap: false, hits: [] }

      const filtered = params.filters.sources !== undefined || params.filters.repo !== undefined
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query(HNSW_SETTINGS)
          const { rows } = await client.query<RelatedRow>(relatedSql(filtered ? FILTERED_RANKED : STORED_RANKED), [
            params.documentId,
            me.embedding,
            me.embed_model,
            params.limit,
            params.filters.sources === undefined ? null : [...params.filters.sources],
            params.filters.repo ?? null,
            params.cutoff,
          ])
          await client.query('COMMIT')
          return {
            inMap: true,
            hits: rows.map((row) => ({
              documentId: Number(row.id),
              sourceKind: row.kind,
              sourceName: row.source_name,
              path: row.path,
              title: row.title,
              allowLlm: row.allow_llm,
              score: row.score,
              passage:
                row.chunk_id === null
                  ? null
                  : {
                      chunkId: Number(row.chunk_id),
                      headingPath: row.heading_path ?? '',
                      startLine: row.start_line,
                      endLine: row.end_line,
                      content: row.content ?? '',
                    },
            })),
          }
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

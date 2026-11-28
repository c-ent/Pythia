import type { Pool } from 'pg'
import type { SearchFilters, SearchableKind } from './searchStore.js'

/** Lowest query-to-chunk cosine similarity for semantic topic map candidates. */
export const TOPIC_MAP_MIN_SIMILARITY = 0.54
/** Lowest cosine similarity for FTS hits when drilling down inside a parent context. */
export const TOPIC_MAP_CONTEXT_MIN_SIMILARITY = 0.48

/** The map-safe documents retrieved for one topic, with stored vectors for grouping. */
export interface TopicMapCandidate {
  documentId: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  allowLlm: boolean
  embedding: number[]
  headingPaths: string[]
  text: string
}

export interface TopicMapSearchParams {
  query: string
  /** Optional FTS query when different from `query` (e.g. `OR` across branch keywords). */
  ftsQuery?: string
  embedding: readonly number[]
  embedModel: string
  filters: SearchFilters
  candidates: number
  limit: number
  /** Maximum cosine distance (`1 - similarity`) for semantic candidates. */
  maxDistance?: number
  /** Optional cosine distance gate applied to FTS hits when scoping to a parent context. */
  ftsMaxDistance?: number
}

/** Read-only hybrid retrieval of map documents; source/repo filters are inside both rankings. */
export interface TopicMapStore {
  search(params: TopicMapSearchParams): Promise<TopicMapCandidate[]>
}

// Each CTE deduplicates to the single best chunk per document so long documents
// (like books or large manuals) cannot consume dozens of candidate slots or
// multiply their RRF score by chunk count.
const TOPIC_MAP_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
fts AS (
  SELECT document_id, row_number() OVER (ORDER BY best_score DESC, document_id) AS rank
  FROM (
    SELECT c.document_id, max(ts_rank_cd(c.fts, q.tsq)) AS best_score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_vectors dv ON dv.document_id = d.id
    JOIN sources s ON s.id = d.source_id
    CROSS JOIN q
    WHERE c.fts @@ q.tsq AND c.embedding IS NOT NULL AND c.embed_model = $7
      AND ($10::float8 IS NULL OR (c.embedding <=> $2::vector) <= $10::float8)
      AND s.enabled AND s.kind <> 'work'
      AND ($3::text[] IS NULL OR s.kind = ANY ($3::text[]))
      AND ($4::text IS NULL OR (s.kind = 'repo' AND s.name = $4::text))
    GROUP BY c.document_id
  ) docs
  ORDER BY best_score DESC, document_id
  LIMIT $5
),
semantic_chunks AS (
  -- Bare distance in ORDER BY lets the HNSW index serve the scan in order.
  SELECT c.document_id, c.embedding <=> $2::vector AS distance
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
  JOIN document_vectors dv ON dv.document_id = d.id
  JOIN sources s ON s.id = d.source_id
  WHERE c.embedding IS NOT NULL AND c.embed_model = $7
    AND ($8::float8 IS NULL OR (c.embedding <=> $2::vector) <= $8::float8)
    AND s.enabled AND s.kind <> 'work'
    AND ($3::text[] IS NULL OR s.kind = ANY ($3::text[]))
    AND ($4::text IS NULL OR (s.kind = 'repo' AND s.name = $4::text))
  ORDER BY c.embedding <=> $2::vector
  LIMIT $9
),
semantic AS (
  SELECT document_id, row_number() OVER (ORDER BY best_distance, document_id) AS rank
  FROM (
    SELECT document_id, min(distance) AS best_distance
    FROM semantic_chunks
    GROUP BY document_id
  ) docs
  ORDER BY best_distance, document_id
  LIMIT $5
),
fused AS (
  SELECT ranked.document_id,
         (coalesce(max(1.0 / (60 + ranked.rank)) FILTER (WHERE ranked.src = 'fts'), 0) +
          coalesce(max(1.0 / (60 + ranked.rank)) FILTER (WHERE ranked.src = 'semantic'), 0)) AS score
  FROM (
    SELECT document_id, rank, 'fts' AS src FROM fts
    UNION ALL
    SELECT document_id, rank, 'semantic' AS src FROM semantic
  ) ranked
  GROUP BY ranked.document_id
  ORDER BY score DESC, ranked.document_id
  LIMIT $6
)
SELECT d.id AS document_id, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm,
       dv.embedding::text AS embedding,
       content.heading_paths,
       content.text
FROM fused f
JOIN documents d ON d.id = f.document_id
JOIN sources s ON s.id = d.source_id
JOIN document_vectors dv ON dv.document_id = d.id AND dv.embed_model = $7
JOIN LATERAL (
  SELECT coalesce(array_agg(part.heading_path ORDER BY part.ordinal), '{}') AS heading_paths,
         coalesce(string_agg(part.content, E'\\n\\n' ORDER BY part.ordinal), '') AS text
  FROM (
    SELECT c.ordinal, c.heading_path, left(c.content, 1500) AS content
    FROM chunks c
    WHERE c.document_id = d.id
    ORDER BY c.ordinal
    LIMIT 8
  ) part
) content ON true
WHERE s.enabled AND s.kind <> 'work'
ORDER BY f.score DESC, d.id`

const toVector = (text: string): number[] => {
  const values = text.replace(/^\[|\]$/g, '').split(',').map(Number)
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return []
  return values
}

export function createPgTopicMapStore(pool: Pool): TopicMapStore {
  return {
    async search(params) {
      const maxDistance = params.maxDistance ?? 1 - TOPIC_MAP_MIN_SIMILARITY
      const chunkScanLimit = Math.max(params.candidates * 4, 200)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query(
            `SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true)`,
            [String(Math.min(1000, Math.max(100, chunkScanLimit)))],
          )
          const { rows } = await client.query<{
            document_id: string
            kind: SearchableKind
            source_name: string
            path: string
            title: string
            allow_llm: boolean
            embedding: string
            heading_paths: string[]
            text: string
          }>(TOPIC_MAP_SQL, [
            params.ftsQuery ?? params.query,
            `[${params.embedding.join(',')}]`,
            params.filters.sources === undefined ? null : [...params.filters.sources],
            params.filters.repo ?? null,
            params.candidates,
            params.limit,
            params.embedModel,
            maxDistance,
            chunkScanLimit,
            params.ftsMaxDistance ?? null,
          ])
          await client.query('COMMIT')
          return rows.map((row) => ({
            documentId: Number(row.document_id),
            sourceKind: row.kind,
            sourceName: row.source_name,
            path: row.path,
            title: row.title,
            allowLlm: row.allow_llm,
            embedding: toVector(row.embedding),
            headingPaths: row.heading_paths,
            text: row.text,
          }))
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

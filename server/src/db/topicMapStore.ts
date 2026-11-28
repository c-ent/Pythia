import type { Pool } from 'pg'
import { sourceFilterSql, toVectorLiteral, visibleSource, withHnswScan } from './pgHelpers.js'
import type { SearchFilters, SearchableKind } from './searchStore.js'

/** Lowest query-to-chunk cosine similarity for semantic topic map candidates. */
export const TOPIC_MAP_MIN_SIMILARITY = 0.62
/** Chunk similarity above which a document passes even if its whole-document mean vector is broad. */
export const TOPIC_MAP_STRONG_SIMILARITY = 0.68
/** Minimum whole-document similarity required for borderline (`0.62..0.68`) semantic chunks. */
export const TOPIC_MAP_DOC_MIN_SIMILARITY = 0.54
/** Lowest cosine similarity for FTS hits when drilling down inside a parent context. */
export const TOPIC_MAP_CONTEXT_MIN_SIMILARITY = 0.54

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
  tags?: string[]
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
  /** Chunk cosine distance (`1 - similarity`) that bypasses the document-vector consistency check. */
  strongMaxDistance?: number
  /** Document-vector cosine distance (`1 - similarity`) required for borderline chunks. */
  docMaxDistance?: number
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
    SELECT c.document_id, max(ts_rank_cd(d.title_fts || c.fts, q.tsq)) AS best_score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_vectors dv ON dv.document_id = d.id AND dv.embed_model = $7
    JOIN sources s ON s.id = d.source_id
    CROSS JOIN q
    WHERE (c.fts @@ q.tsq OR d.title_fts @@ q.tsq) AND (d.title_fts || c.fts) @@ q.tsq AND c.embedding IS NOT NULL AND c.embed_model = $7
      AND ($10::float8 IS NULL OR (c.embedding <=> $2::vector) <= $10::float8)
      AND ${sourceFilterSql(3, 4)}
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
  JOIN document_vectors dv ON dv.document_id = d.id AND dv.embed_model = $7
  JOIN sources s ON s.id = d.source_id
  WHERE c.embedding IS NOT NULL AND c.embed_model = $7
    AND (
      $8::float8 IS NULL
      OR (
        (c.embedding <=> $2::vector) <= $8::float8
        AND (
          $11::float8 IS NULL
          OR $12::float8 IS NULL
          OR (c.embedding <=> $2::vector) <= $11::float8
          OR (dv.embedding <=> $2::vector) <= $12::float8
        )
      )
    )
    AND ${sourceFilterSql(3, 4)}
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
       content.text,
       tag_list.tags
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
LEFT JOIN LATERAL (
  SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') AS tags
  FROM (
    SELECT unnest(d.tags) AS t
    UNION
    SELECT l.target AS t FROM links l WHERE l.document_id = d.id AND l.kind = 'tag'
  ) all_tags
) tag_list ON true
WHERE ${visibleSource()}
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
      const strongMaxDistance = params.strongMaxDistance ?? 1 - TOPIC_MAP_STRONG_SIMILARITY
      const docMaxDistance = params.docMaxDistance ?? 1 - TOPIC_MAP_DOC_MIN_SIMILARITY
      const chunkScanLimit = Math.max(params.candidates * 4, 200)
      return withHnswScan(pool, chunkScanLimit, async (client) => {
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
          tags: string[]
        }>(TOPIC_MAP_SQL, [
          params.ftsQuery ?? params.query,
          toVectorLiteral(params.embedding),
          params.filters.sources === undefined ? null : [...params.filters.sources],
          params.filters.repo ?? null,
          params.candidates,
          params.limit,
          params.embedModel,
          maxDistance,
          chunkScanLimit,
          params.ftsMaxDistance ?? null,
          strongMaxDistance,
          docMaxDistance,
        ])
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
          tags: row.tags ?? [],
        }))
      })
    },
  }
}

import type { Pool } from 'pg'
import type { SearchFilters, SearchableKind } from './searchStore.js'

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
  embedding: readonly number[]
  embedModel: string
  filters: SearchFilters
  candidates: number
  limit: number
}

/** Read-only hybrid retrieval of map documents; source/repo filters are inside both rankings. */
export interface TopicMapStore {
  search(params: TopicMapSearchParams): Promise<TopicMapCandidate[]>
}

const TOPIC_MAP_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
fts AS (
  SELECT c.id, row_number() OVER (ORDER BY score DESC, id) AS rank
  FROM (
    SELECT c.id, ts_rank_cd(c.fts, q.tsq) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_vectors dv ON dv.document_id = d.id
    JOIN sources s ON s.id = d.source_id
    CROSS JOIN q
    WHERE c.fts @@ q.tsq AND c.embedding IS NOT NULL AND c.embed_model = $7
      AND s.enabled AND s.kind <> 'work'
      AND ($3::text[] IS NULL OR s.kind = ANY ($3::text[]))
      AND ($4::text IS NULL OR (s.kind = 'repo' AND s.name = $4::text))
    ORDER BY score DESC, c.id
    LIMIT $5
  ) c
),
semantic AS (
  SELECT c.id, row_number() OVER (ORDER BY distance, id) AS rank
  FROM (
    SELECT c.id, c.embedding <=> $2::vector AS distance
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN document_vectors dv ON dv.document_id = d.id
    JOIN sources s ON s.id = d.source_id
    WHERE c.embedding IS NOT NULL AND c.embed_model = $7
      AND s.enabled AND s.kind <> 'work'
      AND ($3::text[] IS NULL OR s.kind = ANY ($3::text[]))
      AND ($4::text IS NULL OR (s.kind = 'repo' AND s.name = $4::text))
    ORDER BY c.embedding <=> $2::vector
    LIMIT $5
  ) c
),
fused AS (
  SELECT c.document_id,
         sum(1.0 / (60 + ranked.rank)) AS score
  FROM (
    SELECT id, rank FROM fts
    UNION ALL
    SELECT id, rank FROM semantic
  ) ranked
  JOIN chunks c ON c.id = ranked.id
  GROUP BY c.document_id
  ORDER BY score DESC, c.document_id
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
      const { rows } = await pool.query<{
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
        params.query,
        `[${params.embedding.join(',')}]`,
        params.filters.sources === undefined ? null : [...params.filters.sources],
        params.filters.repo ?? null,
        params.candidates,
        params.limit,
        params.embedModel,
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
      }))
    },
  }
}

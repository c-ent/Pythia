import type { Pool } from 'pg'
import { SUMMARY_PATH } from './repoStore.js'

/** Kinds a search or document lookup can return. `work` never appears (R2). */
export const SEARCHABLE_KINDS = ['obsidian', 'keep', 'repo', 'chat', 'gdrive'] as const
export type SearchableKind = (typeof SEARCHABLE_KINDS)[number]

export interface SearchFilters {
  /** Only these source kinds. */
  sources?: readonly SearchableKind[]
  /** Only the `repo` source with this name. Combined with `sources` by AND. */
  repo?: string
}

export interface HybridSearchParams {
  query: string
  /** Query vector, or null to search full text only (Ollama down). */
  embedding: readonly number[] | null
  /** Vectors from another model are not comparable, so only this model's chunks take part. */
  embedModel: string
  filters: SearchFilters
  /** Rows each of the FTS and vector CTEs keep before fusion. */
  candidates: number
  limit: number
}

export interface ChunkHit {
  chunkId: number
  documentId: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  headingPath: string
  startLine: number | null
  endLine: number | null
  allowLlm: boolean
  score: number
  ftsRank: number | null
  vectorRank: number | null
  /** `ts_headline` output with HEADLINE_START / HEADLINE_STOP around matches. */
  headline: string
}

export interface DocumentSummary {
  id: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  language: string | null
  allowLlm: boolean
  mtime: Date | null
  updatedAt: Date
}

export interface StoredDocument extends DocumentSummary {
  /** Chunk contents in ordinal order. */
  chunks: string[]
}

export interface RecentParams {
  since: Date
  sources?: readonly SearchableKind[]
  limit: number
}

export interface ListDocumentsParams {
  source: SearchableKind
  name?: string
  limit: number
}

export interface ListDocumentsResult {
  documents: DocumentSummary[]
  total: number
}

/** What the search service needs from the database. Tests use an in-memory version. */
export interface SearchStore {
  hybridSearch(params: HybridSearchParams): Promise<ChunkHit[]>
  getDocument(id: number): Promise<StoredDocument | null>
  /** Ids of documents at `path` in sources of `kind` (and `name`, when given). */
  findDocumentIds(kind: SearchableKind, name: string | null, path: string): Promise<number[]>
  recentDocuments(params: RecentParams): Promise<DocumentSummary[]>
  listDocuments(params: ListDocumentsParams): Promise<ListDocumentsResult>
}

export interface ChunkText {
  content: string
  /** Read at load time, so a flag changed since the search still counts. */
  allowLlm: boolean
}

/** Full chunk text for Ask prompts (T13). Missing, `work` and disabled chunks are left out. */
export interface ChunkTextLoader {
  chunkTexts(ids: readonly number[]): Promise<Map<number, ChunkText>>
}

export function createPgChunkTextLoader(pool: Pool): ChunkTextLoader {
  return {
    async chunkTexts(ids) {
      if (ids.length === 0) return new Map()
      const { rows } = await pool.query<{ id: string; content: string; allow_llm: boolean }>(
        `SELECT c.id, c.content, d.allow_llm
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN sources s ON s.id = d.source_id
         WHERE c.id = ANY ($1::bigint[]) AND s.enabled AND s.kind <> 'work'`,
        [ids.map(String)],
      )
      return new Map(rows.map((row) => [Number(row.id), { content: row.content, allowLlm: row.allow_llm }]))
    },
  }
}

// Control characters cannot occur in note text once the content is passed
// through `translate`, so they mark matches without any HTML in the API.
export const HEADLINE_START = '\u0001'
export const HEADLINE_STOP = '\u0002'
const HEADLINE_OPTIONS = `StartSel=${HEADLINE_START},StopSel=${HEADLINE_STOP},MaxWords=35,MinWords=15,ShortWord=3,MaxFragments=2,FragmentDelimiter=" … "`

/** RRF constant from spec R4. */
export const RRF_K = 60

// Shared by both CTEs so filtered-out rows never take one of the top slots.
// Uses $3 (kinds or null) and $4 (repo name or null).
const SOURCE_FILTER = `s.enabled AND s.kind <> 'work'
  AND ($3::text[] IS NULL OR s.kind = ANY ($3::text[]))
  AND ($4::text IS NULL OR (s.kind = 'repo' AND s.name = $4::text))`

// With a query vector, full text needs every word (`websearch_to_tsquery`).
// Without one (Ollama down or timed out, T50) a question like "what should I
// post on LinkedIn to get noticed" would match nothing, so the words are ORed
// instead and `ts_rank_cd` puts chunks matching more of them first. Queries
// with a phrase (`<->`) or an exclusion (`!`) keep the strict form, so
// "-word" still excludes. Lexemes never contain spaces, `!` or `<`.
const HYBRID_SQL = `
WITH strict AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
q AS (
  SELECT CASE
    WHEN $2::vector IS NULL AND strpos(tsq::text, '!') = 0 AND strpos(tsq::text, '<') = 0
      THEN replace(tsq::text, ' & ', ' | ')::tsquery
    ELSE tsq
  END AS tsq
  FROM strict
),
fts AS (
  SELECT id, row_number() OVER (ORDER BY score DESC, id) AS rank
  FROM (
    SELECT c.id, ts_rank_cd(c.fts, q.tsq) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    CROSS JOIN q
    WHERE c.fts @@ q.tsq AND ${SOURCE_FILTER}
    ORDER BY score DESC, c.id
    LIMIT $5
  ) t
),
vec AS (
  SELECT id, row_number() OVER (ORDER BY distance, id) AS rank
  FROM (
    -- ORDER BY is the bare distance so the HNSW index can serve it.
    SELECT c.id, c.embedding <=> $2::vector AS distance
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    WHERE $2::vector IS NOT NULL AND c.embedding IS NOT NULL AND c.embed_model = $8 AND ${SOURCE_FILTER}
    ORDER BY c.embedding <=> $2::vector
    LIMIT $5
  ) t
),
fused AS (
  SELECT id,
         sum(1.0 / (${RRF_K} + rank))::float8 AS score,
         min(rank) FILTER (WHERE src = 'fts') AS fts_rank,
         min(rank) FILTER (WHERE src = 'vec') AS vector_rank
  FROM (SELECT id, rank, 'fts' AS src FROM fts UNION ALL SELECT id, rank, 'vec' AS src FROM vec) r
  GROUP BY id
  ORDER BY score DESC, id
  LIMIT $6
)
SELECT f.id AS chunk_id, f.score, f.fts_rank, f.vector_rank,
       c.document_id, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm,
       c.heading_path, c.start_line, c.end_line,
       ts_headline('english', translate(c.content, chr(1) || chr(2), ''), q.tsq, $7) AS headline
FROM fused f
JOIN chunks c ON c.id = f.id
JOIN documents d ON d.id = c.document_id
JOIN sources s ON s.id = d.source_id
CROSS JOIN q
ORDER BY f.score DESC, f.id`

interface HitRow {
  chunk_id: string
  score: number
  fts_rank: string | null
  vector_rank: string | null
  document_id: string
  kind: SearchableKind
  source_name: string
  path: string
  title: string
  allow_llm: boolean
  heading_path: string
  start_line: number | null
  end_line: number | null
  headline: string
}

interface DocumentRow {
  id: string
  kind: SearchableKind
  source_name: string
  path: string
  title: string
  language: string | null
  allow_llm: boolean
  mtime: Date | null
  updated_at: Date
}

const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: Number(row.id),
  sourceKind: row.kind,
  sourceName: row.source_name,
  path: row.path,
  title: row.title,
  language: row.language,
  allowLlm: row.allow_llm,
  mtime: row.mtime,
  updatedAt: row.updated_at,
})

const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`

const DOCUMENT_COLUMNS = `d.id, s.kind, s.name AS source_name, d.path, d.title, d.language, d.allow_llm, d.mtime, d.updated_at`
const VISIBLE_SOURCE = `s.enabled AND s.kind <> 'work'`

export function createPgSearchStore(pool: Pool): SearchStore {
  return {
    async hybridSearch(params) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // HNSW returns at most ef_search rows (default 40, below the 50
          // candidates), and a filter applied after the index scan would leave
          // fewer. Iterative scans keep reading the index until LIMIT is met.
          await client.query(
            `SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true)`,
            [String(Math.min(1000, Math.max(100, params.candidates * 2)))],
          )
          const { rows } = await client.query<HitRow>(HYBRID_SQL, [
            params.query,
            params.embedding === null ? null : toVectorLiteral(params.embedding),
            params.filters.sources === undefined ? null : [...params.filters.sources],
            params.filters.repo ?? null,
            params.candidates,
            params.limit,
            HEADLINE_OPTIONS,
            params.embedModel,
          ])
          await client.query('COMMIT')
          return rows.map((row) => ({
            chunkId: Number(row.chunk_id),
            documentId: Number(row.document_id),
            sourceKind: row.kind,
            sourceName: row.source_name,
            path: row.path,
            title: row.title,
            headingPath: row.heading_path,
            startLine: row.start_line,
            endLine: row.end_line,
            allowLlm: row.allow_llm,
            score: row.score,
            ftsRank: row.fts_rank === null ? null : Number(row.fts_rank),
            vectorRank: row.vector_rank === null ? null : Number(row.vector_rank),
            headline: row.headline,
          }))
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async getDocument(id) {
      const { rows } = await pool.query<DocumentRow & { chunks: string[] }>(
        `SELECT ${DOCUMENT_COLUMNS},
                coalesce((SELECT array_agg(c.content ORDER BY c.ordinal) FROM chunks c WHERE c.document_id = d.id), '{}') AS chunks
         FROM documents d JOIN sources s ON s.id = d.source_id
         WHERE d.id = $1 AND ${VISIBLE_SOURCE}`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : { ...toSummary(row), chunks: row.chunks }
    },

    async findDocumentIds(kind, name, path) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT d.id FROM documents d JOIN sources s ON s.id = d.source_id
         WHERE s.kind = $1 AND ($2::text IS NULL OR s.name = $2::text) AND d.path = $3 AND ${VISIBLE_SOURCE}
         ORDER BY d.id`,
        [kind, name, path],
      )
      return rows.map((row) => Number(row.id))
    },

    async recentDocuments(params) {
      const { rows } = await pool.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS}
         FROM documents d JOIN sources s ON s.id = d.source_id
         WHERE ${VISIBLE_SOURCE}
           AND ($2::text[] IS NULL OR s.kind = ANY ($2::text[]))
           AND coalesce(d.mtime, d.updated_at) >= $1
         ORDER BY coalesce(d.mtime, d.updated_at) DESC, d.id DESC
         LIMIT $3`,
        [params.since, params.sources === undefined ? null : [...params.sources], params.limit],
      )
      return rows.map(toSummary)
    },

    async listDocuments(params) {
      const { rows } = await pool.query<DocumentRow & { total_count: string }>(
        `SELECT ${DOCUMENT_COLUMNS}, count(*) OVER() AS total_count
         FROM documents d JOIN sources s ON s.id = d.source_id
         WHERE ${VISIBLE_SOURCE}
           AND s.kind = $1
           AND ($2::text IS NULL OR s.name = $2::text)
           AND (s.kind <> 'repo' OR d.path <> $3)
         ORDER BY lower(d.path), d.path, d.id
         LIMIT $4`,
        [params.source, params.name ?? null, SUMMARY_PATH, params.limit],
      )
      const total = rows[0] === undefined ? 0 : Number(rows[0].total_count)
      return { documents: rows.map(toSummary), total }
    },
  }
}

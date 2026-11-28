import type { Pool } from 'pg'
import { parseRepoSummaryMetadata } from '../search/repoService.js'
import { sourceFilterSql, toVectorLiteral, visibleSource, withHnswScan } from './pgHelpers.js'
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

export interface Snippet {
  text: string
  /** `[start, end)` offsets into `text`, in UTF-16 code units. */
  highlights: Array<[number, number]>
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
  snippet: Snippet
  mtime?: Date | null
  updatedAt?: Date
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

export interface RepoCatalogEntry {
  chunkId: number
  documentId: number
  name: string
  title: string
  headingPath: string
  allowLlm: boolean
  firstCommitAt: Date | null
  lastCommitAt: Date | null
  updatedAt: Date
  languages: string | null
}

export interface RecentCatalogEntry {
  chunkId: number | null
  documentId: number
  source: { kind: SearchableKind; name: string }
  path: string
  title: string
  headingPath: string
  allowLlm: boolean
  mtime: Date | null
  updatedAt: Date
}

/** Index-wide repo & recency metadata for Ask context (R8). */
export interface AskContextLoader {
  repoCatalog(filters: SearchFilters): Promise<RepoCatalogEntry[]>
  recentDocuments(filters: SearchFilters, limit: number): Promise<RecentCatalogEntry[]>
}

export function createPgAskContextLoader(pool: Pool): AskContextLoader {
  return {
    async repoCatalog(filters) {
      if (filters.sources !== undefined && !filters.sources.includes('repo')) return []
      const { rows } = await pool.query<{
        chunk_id: string
        document_id: string
        source_name: string
        title: string
        heading_path: string
        allow_llm: boolean
        mtime: Date | null
        updated_at: Date
        content: string
      }>(
        `SELECT c.id AS chunk_id, d.id AS document_id, s.name AS source_name,
                d.title, c.heading_path, d.allow_llm, d.mtime, d.updated_at, c.content
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         JOIN chunks c ON c.document_id = d.id AND c.ordinal = 0
         WHERE s.enabled AND s.kind = 'repo' AND NOT d.excluded AND d.path = $1
           AND ($2::text IS NULL OR s.name = $2::text)
         ORDER BY coalesce(d.mtime, d.updated_at) DESC, s.name`,
        [SUMMARY_PATH, filters.repo ?? null],
      )
      return rows
        .map((row) => {
          const meta = parseRepoSummaryMetadata(row.content, row.mtime)
          return {
            chunkId: Number(row.chunk_id),
            documentId: Number(row.document_id),
            name: row.source_name,
            title: row.title,
            headingPath: row.heading_path,
            allowLlm: row.allow_llm,
            firstCommitAt: meta.firstCommitAt,
            lastCommitAt: meta.lastCommitAt,
            updatedAt: row.updated_at,
            languages: meta.languages,
          }
        })
        .sort((a, b) => {
          const ac = a.lastCommitAt ?? a.firstCommitAt
          const bc = b.lastCommitAt ?? b.firstCommitAt
          if (ac !== null && bc !== null) {
            const diff = bc.getTime() - ac.getTime()
            if (diff !== 0) return diff
          } else if (ac !== null || bc !== null) {
            return bc !== null ? 1 : -1
          }
          return b.updatedAt.getTime() - a.updatedAt.getTime() || a.name.localeCompare(b.name)
        })
    },

    async recentDocuments(filters, limit) {
      const { rows } = await pool.query<{
        chunk_id: string | null
        document_id: string
        kind: SearchableKind
        source_name: string
        path: string
        title: string
        heading_path: string | null
        allow_llm: boolean
        mtime: Date | null
        updated_at: Date
      }>(
        `SELECT c.id AS chunk_id, d.id AS document_id, s.kind, s.name AS source_name,
                d.path, d.title, c.heading_path, d.allow_llm, d.mtime, d.updated_at
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         LEFT JOIN LATERAL (
           SELECT id, heading_path FROM chunks WHERE document_id = d.id ORDER BY ordinal LIMIT 1
         ) c ON true
         WHERE ${VISIBLE_SOURCE}
           AND ($1::text[] IS NULL OR s.kind = ANY ($1::text[]))
           AND ($2::text IS NULL OR (s.kind = 'repo' AND s.name = $2::text))
           AND NOT (s.kind = 'repo' AND d.path = $3)
         ORDER BY coalesce(d.mtime, d.updated_at) DESC, d.id DESC
         LIMIT $4`,
        [filters.sources === undefined ? null : [...filters.sources], filters.repo ?? null, SUMMARY_PATH, limit],
      )
      return rows.map((row) => ({
        chunkId: row.chunk_id === null ? null : Number(row.chunk_id),
        documentId: Number(row.document_id),
        source: { kind: row.kind, name: row.source_name },
        path: row.path,
        title: row.title,
        headingPath: row.heading_path ?? row.title,
        allowLlm: row.allow_llm,
        mtime: row.mtime,
        updatedAt: row.updated_at,
      }))
    },
  }
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
         WHERE c.id = ANY ($1::bigint[]) AND s.enabled AND s.kind <> 'work' AND NOT d.excluded`,
        [ids.map(String)],
      )
      return new Map(rows.map((row) => [Number(row.id), { content: row.content, allowLlm: row.allow_llm }]))
    },
  }
}

// Control characters cannot occur in note text once the content is passed
// through `translate`, so they mark matches without any HTML in the API.
const HEADLINE_START = '\u0001'
const HEADLINE_STOP = '\u0002'
const HEADLINE_OPTIONS = `StartSel=${HEADLINE_START},StopSel=${HEADLINE_STOP},MaxWords=35,MinWords=15,ShortWord=3,MaxFragments=2,FragmentDelimiter=" … "`

/** Turns `ts_headline` output into plain text plus match offsets behind the SearchStore seam. */
export function parseHeadline(raw: string): Snippet {
  let text = ''
  const highlights: Array<[number, number]> = []
  let start: number | null = null
  for (const ch of raw) {
    if (ch === HEADLINE_START) {
      start ??= text.length
    } else if (ch === HEADLINE_STOP) {
      if (start !== null && text.length > start) highlights.push([start, text.length])
      start = null
    } else {
      text += ch
    }
  }
  if (start !== null && text.length > start) highlights.push([start, text.length])
  return { text, highlights }
}

/** RRF constant from spec R4. */
export const RRF_K = 60

// Shared by both CTEs so filtered-out rows never take one of the top slots.
// Uses $3 (kinds or null) and $4 (repo name or null).
const SOURCE_FILTER = sourceFilterSql(3, 4)

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
    SELECT c.id, ts_rank_cd(d.title_fts || c.fts, q.tsq) AS score
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN sources s ON s.id = d.source_id
    CROSS JOIN q
    WHERE (c.fts @@ q.tsq OR d.title_fts @@ q.tsq) AND (d.title_fts || c.fts) @@ q.tsq AND ${SOURCE_FILTER}
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
       c.document_id, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm, d.mtime, d.updated_at,
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
  mtime: Date | null
  updated_at: Date
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

const DOCUMENT_COLUMNS = `d.id, s.kind, s.name AS source_name, d.path, d.title, d.language, d.allow_llm, d.mtime, d.updated_at`
const VISIBLE_SOURCE = visibleSource()

export function createPgSearchStore(pool: Pool): SearchStore {
  return {
    async hybridSearch(params) {
      return withHnswScan(pool, params.candidates * 2, async (client) => {
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
          snippet: parseHeadline(row.headline),
          mtime: row.mtime,
          updatedAt: row.updated_at,
        }))
      })
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

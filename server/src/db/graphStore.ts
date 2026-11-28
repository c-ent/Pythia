import type { Pool } from 'pg'
import type { LinkKind } from '../ingest/links.js'
import { createPgBacklinkStore, type SourceNote } from './linkStore.js'
import { NEIGHBOUR_CUTOFF } from './neighbourStore.js'
import type { SearchableKind, SearchFilters } from './searchStore.js'

/**
 * Reads for the knowledge map graphs (R20, T70): map documents (a row in
 * `document_vectors`), their `links` rows and their stored
 * `document_neighbours`. Every query applies the visibility rules and the
 * source and repo filters itself (R4): switched-off sources and `work` never
 * come back. Building the graph is the graph service's job.
 */

export interface GraphFilters extends SearchFilters {
  /** Shown whatever `sources` and `repo` say: the opened document of a local graph. */
  always?: number
}

/** A map document: a visible document with a map vector. */
export interface MapDocument {
  id: number
  sourceId: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  allowLlm: boolean
}

export interface GraphDocument extends MapDocument {
  /** False when the document has no map vector (repo code, boilerplate, no stored chunks). */
  inMap: boolean
}

export interface GraphLinkRow {
  documentId: number
  /** The linking document's source. */
  sourceId: number
  ordinal: number
  kind: LinkKind
  target: string
  targetKey: string
}

export interface NeighbourRow {
  documentId: number
  neighbourId: number
  rank: number
  score: number
}

export interface DocumentQuery {
  /** Only these documents. */
  ids?: readonly number[]
  /** Only documents of these sources. */
  sourceIds?: readonly number[]
}

export interface LinkQuery {
  kinds: readonly LinkKind[]
  /** Only rows of these linking documents. */
  documentIds?: readonly number[]
  /** Only rows with one of these `target_key`s. */
  targetKeys?: readonly string[]
  /** Only rows of documents in this source. */
  sourceId?: number
}

export interface NeighbourQuery {
  /** Only rows with one of these documents at either end. */
  documentIds?: readonly number[]
  /** Only the first N of each stored list. */
  maxRank?: number
}

/** What the graph service needs from the database. Tests use an in-memory version. */
export interface GraphStore {
  /** Null when the document does not exist or is not visible (work, switched-off source). */
  document(documentId: number): Promise<GraphDocument | null>
  /** Map documents passing the filters, by id. */
  mapDocuments(query: DocumentQuery, filters: GraphFilters): Promise<MapDocument[]>
  /** Link rows of map documents passing the filters, by document then stored order. */
  links(query: LinkQuery, filters: GraphFilters): Promise<GraphLinkRow[]>
  /** Every document of the source with its aliases: what note links resolve against (not filtered). */
  notes(sourceId: number): Promise<SourceNote[]>
  /** Stored neighbour rows whose two ends both pass the filters. */
  neighbours(query: NeighbourQuery, filters: GraphFilters): Promise<NeighbourRow[]>
}

// Uses $1 (kinds or null), $2 (repo name or null) and $3 (the always-shown
// document or null). Same visibility and filters as hybrid search.
const visible = (s: string, d: string): string => `${s}.enabled AND ${s}.kind <> 'work' AND NOT ${d}.excluded
  AND (${d}.id = $3::bigint OR (
    ($1::text[] IS NULL OR ${s}.kind = ANY ($1::text[]))
    AND ($2::text IS NULL OR (${s}.kind = 'repo' AND ${s}.name = $2::text))))`

const filterParams = (filters: GraphFilters): unknown[] => [
  filters.sources === undefined ? null : [...filters.sources],
  filters.repo ?? null,
  filters.always ?? null,
]

const orNull = <T>(values: readonly T[] | undefined): T[] | null => (values === undefined ? null : [...values])

interface DocumentRow {
  id: string
  source_id: string
  kind: SearchableKind
  source_name: string
  path: string
  title: string
  allow_llm: boolean
}

const toDocument = (row: DocumentRow): MapDocument => ({
  id: Number(row.id),
  sourceId: Number(row.source_id),
  sourceKind: row.kind,
  sourceName: row.source_name,
  path: row.path,
  title: row.title,
  allowLlm: row.allow_llm,
})

export function createPgGraphStore(pool: Pool, options: { cutoff?: number } = {}): GraphStore {
  const cutoff = options.cutoff ?? NEIGHBOUR_CUTOFF
  const backlinks = createPgBacklinkStore(pool)
  return {
    async document(documentId) {
      const { rows } = await pool.query<DocumentRow & { in_map: boolean }>(
        `SELECT d.id, d.source_id, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm,
                (v.document_id IS NOT NULL) AS in_map
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         LEFT JOIN document_vectors v ON v.document_id = d.id
         WHERE d.id = $1 AND s.enabled AND s.kind <> 'work' AND NOT d.excluded`,
        [documentId],
      )
      const row = rows[0]
      return row === undefined ? null : { ...toDocument(row), inMap: row.in_map }
    },

    async mapDocuments(query, filters) {
      if (query.ids?.length === 0 || query.sourceIds?.length === 0) return []
      const { rows } = await pool.query<DocumentRow>(
        `SELECT d.id, d.source_id, s.kind, s.name AS source_name, d.path, d.title, d.allow_llm
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         JOIN document_vectors v ON v.document_id = d.id
         WHERE ${visible('s', 'd')}
           AND ($4::bigint[] IS NULL OR d.id = ANY ($4::bigint[]))
           AND ($5::bigint[] IS NULL OR d.source_id = ANY ($5::bigint[]))
         ORDER BY d.id`,
        [...filterParams(filters), orNull(query.ids), orNull(query.sourceIds)],
      )
      return rows.map(toDocument)
    },

    async links(query, filters) {
      if (query.kinds.length === 0 || query.documentIds?.length === 0 || query.targetKeys?.length === 0) return []
      const { rows } = await pool.query<{
        document_id: string
        source_id: string
        ordinal: number
        kind: LinkKind
        target: string
        target_key: string
      }>(
        `SELECT l.document_id, d.source_id, l.ordinal, l.kind, l.target, l.target_key
         FROM links l
         JOIN documents d ON d.id = l.document_id
         JOIN sources s ON s.id = d.source_id
         JOIN document_vectors v ON v.document_id = d.id
         WHERE ${visible('s', 'd')}
           AND l.kind = ANY ($4::text[])
           AND ($5::bigint[] IS NULL OR l.document_id = ANY ($5::bigint[]))
           AND ($6::text[] IS NULL OR l.target_key = ANY ($6::text[]))
           AND ($7::bigint IS NULL OR d.source_id = $7::bigint)
         ORDER BY l.document_id, l.ordinal`,
        [
          ...filterParams(filters),
          [...query.kinds],
          orNull(query.documentIds),
          orNull(query.targetKeys),
          query.sourceId ?? null,
        ],
      )
      return rows.map((row) => ({
        documentId: Number(row.document_id),
        sourceId: Number(row.source_id),
        ordinal: row.ordinal,
        kind: row.kind,
        target: row.target,
        targetKey: row.target_key,
      }))
    },

    notes: (sourceId) => backlinks.notes(sourceId),

    async neighbours(query, filters) {
      if (query.documentIds?.length === 0) return []
      // Both ends keep the model they were compared in (D5) and pass the filters.
      const { rows } = await pool.query<{ document_id: string; neighbour_id: string; rank: number; score: number }>(
        `SELECT n.document_id, n.neighbour_id, n.rank, n.score::float8 AS score
         FROM document_neighbours n
         JOIN document_vectors v1 ON v1.document_id = n.document_id AND v1.embed_model = n.embed_model
         JOIN document_vectors v2 ON v2.document_id = n.neighbour_id AND v2.embed_model = n.embed_model
         JOIN documents d1 ON d1.id = n.document_id
         JOIN sources s1 ON s1.id = d1.source_id
         JOIN documents d2 ON d2.id = n.neighbour_id
         JOIN sources s2 ON s2.id = d2.source_id
         WHERE ${visible('s1', 'd1')} AND ${visible('s2', 'd2')}
           AND n.score >= $4 AND ($5::int IS NULL OR n.rank <= $5::int)
           AND ($6::bigint[] IS NULL OR n.document_id = ANY ($6::bigint[]) OR n.neighbour_id = ANY ($6::bigint[]))
         ORDER BY n.document_id, n.rank`,
        [...filterParams(filters), cutoff, query.maxRank ?? null, orNull(query.documentIds)],
      )
      return rows.map((row) => ({
        documentId: Number(row.document_id),
        neighbourId: Number(row.neighbour_id),
        rank: row.rank,
        score: row.score,
      }))
    },
  }
}

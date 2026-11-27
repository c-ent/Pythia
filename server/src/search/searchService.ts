import {
  HEADLINE_START,
  HEADLINE_STOP,
  type ChunkHit,
  type DocumentSummary,
  type SearchableKind,
  type SearchStore,
  type StoredDocument,
} from '../db/searchStore.js'
import { OllamaError, type Embedder } from '../embed/ollama.js'

/** Rows each of the FTS and vector CTEs keep before fusion (spec R4). */
export const SEARCH_CANDIDATES = 50
export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = SEARCH_CANDIDATES
/** Matches the 200 KB repo file cap (R9); notes are far smaller. */
export const DEFAULT_MAX_DOCUMENT_CHARS = 200_000
const DAY_MS = 24 * 60 * 60 * 1000

/** Input the service refuses; transports map it to 400. */
export class SearchInputError extends Error {
  override name = 'SearchInputError'
}

/** Several sources of the kind hold the path; the caller must name one. Maps to 409. */
export class AmbiguousDocumentError extends Error {
  override name = 'AmbiguousDocumentError'
}

export interface Snippet {
  text: string
  /** `[start, end)` offsets into `text`, in UTF-16 code units. */
  highlights: Array<[number, number]>
}

export interface SourceRef {
  kind: SearchableKind
  name: string
}

export interface SearchRequest {
  query: string
  sources?: readonly SearchableKind[]
  repo?: string
  limit?: number
}

export interface SearchResult {
  chunkId: number
  documentId: number
  source: SourceRef
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
}

export interface SearchResponse {
  results: SearchResult[]
  /** True when the query could not be embedded and only full-text search ran. */
  degraded: boolean
}

export interface DocumentInfo {
  id: number
  source: SourceRef
  path: string
  title: string
  language: string | null
  allowLlm: boolean
  mtime: Date | null
  updatedAt: Date
}

export interface DocumentView extends DocumentInfo {
  content: string
  truncated: boolean
  totalChars: number
}

export interface RecentRequest {
  days: number
  source?: SearchableKind
  limit: number
}

export interface SearchService {
  search(request: SearchRequest): Promise<SearchResponse>
  getDocument(id: number): Promise<DocumentView | null>
  /** `name` picks the source when several of `kind` exist (repos). */
  findDocument(kind: SearchableKind, name: string | null, path: string): Promise<DocumentView | null>
  recent(request: RecentRequest): Promise<DocumentInfo[]>
}

export interface SearchServiceOptions {
  store: SearchStore
  /** Embeds queries. Should fail fast: search waits on it. */
  embedder: Embedder
  now?: () => Date
  log?: (message: string) => void
  maxDocumentChars?: number
}

/** Turns `ts_headline` output into plain text plus match offsets. */
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

/**
 * Cuts `text` to at most `max` characters: at the last line break in the
 * second half of the allowance, otherwise hard at the cap, never between the
 * halves of a surrogate pair.
 */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  const lineBreak = text.lastIndexOf('\n', max)
  if (lineBreak >= max / 2) return { text: text.slice(0, lineBreak).replace(/\n+$/, ''), truncated: true }
  let cut = max
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut--
  return { text: text.slice(0, cut), truncated: true }
}

const toInfo = (doc: DocumentSummary): DocumentInfo => ({
  id: doc.id,
  source: { kind: doc.sourceKind, name: doc.sourceName },
  path: doc.path,
  title: doc.title,
  language: doc.language,
  allowLlm: doc.allowLlm,
  mtime: doc.mtime,
  updatedAt: doc.updatedAt,
})

const toResult = (hit: ChunkHit): SearchResult => ({
  chunkId: hit.chunkId,
  documentId: hit.documentId,
  source: { kind: hit.sourceKind, name: hit.sourceName },
  path: hit.path,
  title: hit.title,
  headingPath: hit.headingPath,
  startLine: hit.startLine,
  endLine: hit.endLine,
  allowLlm: hit.allowLlm,
  score: hit.score,
  ftsRank: hit.ftsRank,
  vectorRank: hit.vectorRank,
  snippet: parseHeadline(hit.headline),
})

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const status = 'status' in error && typeof error.status === 'number' ? ` ${error.status}` : ''
  // OllamaError messages never contain the input text (see embed/ollama.ts),
  // so they are safe to log; other errors still log their kind only.
  const detail = error instanceof OllamaError ? `: ${error.message}` : ''
  return `${error.name}${status}${detail}`
}

/** The one search path shared by REST routes and `/mcp` tools. */
export function createSearchService(options: SearchServiceOptions): SearchService {
  const { store, embedder } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((message: string) => console.warn(message))
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS

  const view = (doc: StoredDocument): DocumentView => {
    // Chunks hold the note body section by section; frontmatter is not kept.
    const full = doc.chunks.join('\n\n')
    const capped = capText(full, maxChars)
    return { ...toInfo(doc), content: capped.text, truncated: capped.truncated, totalChars: full.length }
  }

  return {
    async search(request) {
      const query = request.query.trim()
      if (query.length === 0) throw new SearchInputError('query must not be empty')
      const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(request.limit ?? DEFAULT_SEARCH_LIMIT)))

      let embedding: number[] | null = null
      try {
        embedding = await embedder.embedQuery(query)
      } catch (error) {
        // The query may be private, so only the error kind is logged.
        log(`query embedding failed (${describeError(error)}); searching full text only`)
      }

      const hits = await store.hybridSearch({
        query,
        embedding,
        embedModel: embedder.model,
        filters: { sources: request.sources, repo: request.repo },
        candidates: SEARCH_CANDIDATES,
        limit,
      })
      return { results: hits.map(toResult), degraded: embedding === null }
    },

    async getDocument(id) {
      const doc = await store.getDocument(id)
      return doc === null ? null : view(doc)
    },

    async findDocument(kind, name, path) {
      const ids = await store.findDocumentIds(kind, name, path)
      if (ids.length > 1) throw new AmbiguousDocumentError(`more than one ${kind} source has this path; name the source`)
      const id = ids[0]
      if (id === undefined) return null
      const doc = await store.getDocument(id)
      return doc === null ? null : view(doc)
    },

    async recent(request) {
      const since = new Date(now().getTime() - request.days * DAY_MS)
      const docs = await store.recentDocuments({
        since,
        sources: request.source === undefined ? undefined : [request.source],
        limit: request.limit,
      })
      return docs.map(toInfo)
    },
  }
}

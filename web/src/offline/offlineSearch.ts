import MiniSearch from 'minisearch'
import type { SearchResult, SourceKind } from '../api/search'
import { offlineDb, type CachedDocument, type OfflineDb } from './db'
import { readSyncState } from './sync'

/**
 * Keyword search over the offline cache (R11), used when the browser is
 * offline. A MiniSearch (BM25) index built in memory from the cached
 * documents: title and path matches count more than body matches, and the
 * last query word also matches as a prefix (search-as-you-type). It is rebuilt
 * only when the cache changes (a new sync cursor or document count).
 */

const FIELD_BOOST = { title: 3, path: 2, content: 1 } as const
const PREFIX_WEIGHT = 0.6
const SNIPPET_CHARS = 240
export const OFFLINE_RESULT_LIMIT = 30

interface OfflineIndex {
  key: string
  docs: Map<number, CachedDocument>
  engine: MiniSearch<CachedDocument>
}

/** Lower-case words of two or more letters or digits, accents removed. */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? []
  )
}

export function buildIndex(documents: readonly CachedDocument[], key = ''): OfflineIndex {
  const engine = new MiniSearch<CachedDocument>({
    idField: 'id',
    fields: ['title', 'path', 'content'],
    // `tokenize` already lower-cases and drops accents; queries use the same rules.
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term,
  })
  engine.addAll(documents)
  return { key, docs: new Map(documents.map((doc) => [doc.id, doc])), engine }
}

export interface OfflineSearchParams {
  query: string
  sources?: readonly SourceKind[]
  limit?: number
}

/** Ranks cached documents for a query. Pure; the result shape matches online search. */
export function searchIndex(index: OfflineIndex, params: OfflineSearchParams): SearchResult[] {
  const words = [...new Set(tokenize(params.query))]
  if (words.length === 0 || index.docs.size === 0) return []
  const allowed = params.sources !== undefined && params.sources.length > 0 ? new Set(params.sources) : null

  const hits = index.engine.search(words.join(' '), {
    combineWith: 'OR',
    boost: { title: FIELD_BOOST.title, path: FIELD_BOOST.path, content: FIELD_BOOST.content },
    prefix: (_term, position, terms) => position === terms.length - 1,
    fuzzy: false,
    weights: { fuzzy: 0, prefix: PREFIX_WEIGHT },
    filter: (hit) => allowed === null || allowed.has(index.docs.get(hit.id as number)?.sourceKind as SourceKind),
  })

  return hits
    // Documents that match every word come first.
    .map((hit) => ({
      id: hit.id as number,
      terms: hit.terms,
      score: hit.score * (new Set(hit.queryTerms).size / words.length) ** 2,
    }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, params.limit ?? OFFLINE_RESULT_LIMIT)
    .map(({ id, terms, score }) => toResult(index.docs.get(id)!, terms, score))
}

function toResult(doc: CachedDocument, terms: string[], score: number): SearchResult {
  return {
    chunkId: doc.id,
    documentId: doc.id,
    source: { kind: doc.sourceKind as SourceKind, name: doc.sourceName },
    path: doc.path,
    title: doc.title,
    headingPath: '',
    startLine: null,
    endLine: null,
    allowLlm: doc.allowLlm,
    score,
    ftsRank: null,
    vectorRank: null,
    snippet: makeSnippet(doc.content, terms),
  }
}

const escape = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A window of the text around the first match, with every match in it highlighted. */
export function makeSnippet(content: string, terms: readonly string[]): SearchResult['snippet'] {
  const pattern =
    terms.length === 0
      ? null
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...terms].sort((a, b) => b.length - a.length).map(escape).join('|')})`, 'giu')
  const first = pattern === null ? -1 : content.search(pattern)
  let start = first <= 0 ? 0 : Math.max(0, first - SNIPPET_CHARS / 4)
  // Start at a word boundary so the window does not open mid-word.
  if (start > 0) {
    const space = content.indexOf(' ', start)
    if (space !== -1 && space < first) start = space + 1
  }
  let end = Math.min(content.length, start + SNIPPET_CHARS)
  if (end < content.length) {
    const space = content.lastIndexOf(' ', end)
    if (space > start) end = space
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < content.length ? '…' : ''
  const body = content.slice(start, end)
  const highlights: Array<[number, number]> = []
  if (pattern !== null) {
    for (const match of body.matchAll(pattern)) {
      const at = prefix.length + (match.index ?? 0)
      highlights.push([at, at + match[0].length])
    }
  }
  return { text: `${prefix}${body}${suffix}`, highlights }
}

let cached: OfflineIndex | null = null

/** Searches the device's cache; builds or reuses the in-memory index. */
export async function searchOffline(params: OfflineSearchParams, db: OfflineDb = offlineDb()): Promise<SearchResult[]> {
  const [state, count] = await Promise.all([readSyncState(db), db.documents.count()])
  const key = `${db.name}:${state?.cursor ?? '0'}:${count}`
  if (cached?.key !== key) cached = buildIndex(await db.documents.toArray(), key)
  return searchIndex(cached, params)
}

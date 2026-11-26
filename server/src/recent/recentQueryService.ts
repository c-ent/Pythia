import { SEARCHABLE_KINDS, type SearchableKind } from '../db/searchStore.js'

/** Recent searches and Ask questions (R14). One list per kind, shared by every device. */
export const RECENT_QUERY_KINDS = ['search', 'ask'] as const
export type RecentQueryKind = (typeof RECENT_QUERY_KINDS)[number]

/** Entries kept per kind; recording the 21st drops the oldest. */
export const MAX_RECENT_QUERIES = 20
/** Longer queries are stored cut to this many characters. */
export const MAX_RECENT_QUERY_CHARS = 500

/** What the query ran with, so rerunning it from the list gives the same results. */
export interface RecentQueryFilters {
  sources?: SearchableKind[]
  repo?: string
}

export interface RecentQuery {
  id: number
  kind: RecentQueryKind
  query: string
  filters: RecentQueryFilters
  /** When it last ran. */
  at: Date
}

export interface RecentQueryStore {
  /** Adds the query, or moves the equal one to the top, then keeps only the newest `keep` of its kind. */
  record(kind: RecentQueryKind, query: string, filters: RecentQueryFilters, keep: number): Promise<void>
  /** Newest first. */
  list(kind: RecentQueryKind, limit: number): Promise<RecentQuery[]>
  /** False when there was no such entry. */
  remove(id: number): Promise<boolean>
  clear(kind: RecentQueryKind): Promise<void>
}

export interface RecentQueryService {
  /**
   * Records a query that ran successfully. Never throws: a list entry that
   * cannot be saved must not fail the search or answer that was already made.
   */
  record(kind: RecentQueryKind, query: string, filters?: RecentQueryFilters): Promise<void>
  list(kind: RecentQueryKind, limit?: number): Promise<RecentQuery[]>
  remove(id: number): Promise<boolean>
  clear(kind: RecentQueryKind): Promise<void>
}

/** The text to store: trimmed and cut to `MAX_RECENT_QUERY_CHARS`, or null for an empty query. */
export function normalizeRecentQuery(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed === '') return null
  // Count code points, as Postgres `char_length` does, and never split a surrogate pair.
  const chars = Array.from(trimmed)
  if (chars.length <= MAX_RECENT_QUERY_CHARS) return trimmed
  return chars.slice(0, MAX_RECENT_QUERY_CHARS).join('').trimEnd()
}

/** The filters of a search or ask request, leaving out the ones it did not set. */
export function queryFilters(input: { sources?: readonly SearchableKind[] | undefined; repo?: string | undefined }): RecentQueryFilters {
  return {
    ...(input.sources === undefined ? {} : { sources: [...input.sources] }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
  }
}

/** Reads stored filters defensively: unknown kinds and fields are dropped. */
export function parseRecentQueryFilters(value: unknown): RecentQueryFilters {
  const filters: RecentQueryFilters = {}
  if (value === null || typeof value !== 'object') return filters
  const { sources, repo } = value as Record<string, unknown>
  if (Array.isArray(sources)) {
    const known: readonly string[] = SEARCHABLE_KINDS
    const kinds = sources.filter((kind): kind is SearchableKind => typeof kind === 'string' && known.includes(kind))
    if (kinds.length > 0) filters.sources = kinds
  }
  if (typeof repo === 'string' && repo !== '') filters.repo = repo
  return filters
}

export interface RecentQueryServiceOptions {
  /** Called when recording fails; the default logs the error name only, never the query. */
  onError?: (error: unknown) => void
}

export function createRecentQueryService(
  store: RecentQueryStore,
  { onError = logRecordError }: RecentQueryServiceOptions = {},
): RecentQueryService {
  return {
    async record(kind, query, filters = {}) {
      const text = normalizeRecentQuery(query)
      if (text === null) return
      try {
        await store.record(kind, text, filters, MAX_RECENT_QUERIES)
      } catch (error) {
        onError(error)
      }
    },
    list(kind, limit = MAX_RECENT_QUERIES) {
      return store.list(kind, Math.min(Math.max(1, Math.trunc(limit)), MAX_RECENT_QUERIES))
    },
    remove(id) {
      return store.remove(id)
    },
    clear(kind) {
      return store.clear(kind)
    },
  }
}

function logRecordError(error: unknown): void {
  const name = error instanceof Error ? error.name : 'unknown'
  const code = error !== null && typeof error === 'object' && 'code' in error ? ` ${String(error.code)}` : ''
  console.error(`recent query not recorded: ${name}${code}`)
}

/** For tests and for running without a database. */
export function createMemoryRecentQueryStore(): RecentQueryStore {
  // Newest first, both kinds together.
  let rows: RecentQuery[] = []
  let nextId = 1
  const copy = (row: RecentQuery): RecentQuery => ({ ...row, filters: structuredClone(row.filters), at: new Date(row.at) })
  return {
    async record(kind, query, filters, keep) {
      const existing = rows.find((row) => row.kind === kind && row.query === query)
      rows = rows.filter((row) => row !== existing)
      rows.unshift({ id: existing?.id ?? nextId++, kind, query, filters: structuredClone(filters), at: new Date() })
      let kept = 0
      rows = rows.filter((row) => row.kind !== kind || ++kept <= keep)
    },
    async list(kind, limit) {
      return rows
        .filter((row) => row.kind === kind)
        .slice(0, limit)
        .map(copy)
    },
    async remove(id) {
      const before = rows.length
      rows = rows.filter((row) => row.id !== id)
      return rows.length < before
    },
    async clear(kind) {
      rows = rows.filter((row) => row.kind !== kind)
    },
  }
}

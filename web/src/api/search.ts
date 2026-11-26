import { apiFetch } from './client'

// Mirrors the server's search types (server/src/search/searchService.ts).

export const SOURCE_KINDS = ['obsidian', 'repo', 'keep'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface Snippet {
  text: string
  /** `[start, end)` offsets into `text`, in UTF-16 code units. */
  highlights: Array<[number, number]>
}

export interface SourceRef {
  kind: SourceKind
  name: string
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

export interface SearchParams {
  query: string
  sources?: SourceKind[]
  limit?: number
}

export async function searchNotes(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const res = await apiFetch('/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  })
  return (await res.json()) as SearchResponse
}

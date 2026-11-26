import { apiFetch } from './client'
import type { DocumentInfo } from './documents'
import type { SourceKind } from './search'

// Mirrors `GET /api/recent` (recently changed documents) and
// `GET /api/recent-queries` (R14, server/src/routes/recentQueries.ts).

export type RecentQueryKind = 'search' | 'ask'

export interface RecentQuery {
  id: number
  kind: RecentQueryKind
  query: string
  filters: { sources?: SourceKind[]; repo?: string }
  /** When it last ran, ISO. */
  at: string
}

/** Documents changed in the last `days` days, newest first. */
export async function getRecentDocuments(
  params: { days?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<DocumentInfo[]> {
  const query = new URLSearchParams()
  if (params.days !== undefined) query.set('days', String(params.days))
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  const res = await apiFetch(`/api/recent?${query.toString()}`, { signal })
  const body: unknown = await res.json()
  const documents = body !== null && typeof body === 'object' && 'documents' in body ? body.documents : null
  return Array.isArray(documents) ? (documents as DocumentInfo[]) : []
}

/** The owner's recent searches or Ask questions, newest first (at most 20). */
export async function getRecentQueries(
  kind: RecentQueryKind,
  limit?: number,
  signal?: AbortSignal,
): Promise<RecentQuery[]> {
  const query = new URLSearchParams({ kind })
  if (limit !== undefined) query.set('limit', String(limit))
  const res = await apiFetch(`/api/recent-queries?${query.toString()}`, { signal })
  const body: unknown = await res.json()
  const queries = body !== null && typeof body === 'object' && 'queries' in body ? body.queries : null
  if (!Array.isArray(queries)) return []
  return (queries as RecentQuery[]).filter((entry) => typeof entry?.query === 'string' && entry.query !== '')
}

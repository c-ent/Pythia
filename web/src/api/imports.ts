import { apiFetch } from './client'
import type { SourceKind } from './search'

// Mirrors `POST /api/import/keep`, `GET /api/index/status` and
// `POST /api/index/reindex` (server/src/ingest/importService.ts). Dates arrive as ISO strings.

export interface KeepImportResult {
  notes: number
  indexed: number
  unchanged: number
  deleted: number
  failed: number
  skipped: { trashed: number; empty: number; invalid: number; blocked: number; tooLarge: number }
}

export type ReindexState = 'off' | 'idle' | 'running'

export interface ReindexStatus {
  vault: ReindexState
  repos: ReindexState
}

export interface SourceStatus {
  kind: SourceKind | 'chat'
  name: string
  enabled: boolean
  documents: number
  chunks: number
  updatedAt: string | null
}

export interface IndexStatus {
  sources: SourceStatus[]
  reindex: ReindexStatus
}

export async function importKeepZip(file: Blob, signal?: AbortSignal): Promise<KeepImportResult> {
  // Browsers label zips differently (`application/x-zip-compressed` on
  // Windows, empty on some phones); the server checks the bytes either way.
  const res = await apiFetch('/api/import/keep', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: file,
    signal,
  })
  return (await res.json()) as KeepImportResult
}

export async function getIndexStatus(signal?: AbortSignal): Promise<IndexStatus> {
  const res = await apiFetch('/api/index/status', { signal })
  return (await res.json()) as IndexStatus
}

export async function startReindex(): Promise<ReindexStatus> {
  const res = await apiFetch('/api/index/reindex', { method: 'POST' })
  return ((await res.json()) as { reindex: ReindexStatus }).reindex
}

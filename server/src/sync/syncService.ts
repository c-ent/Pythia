import type { SearchableKind } from '../db/searchStore.js'
import type { SyncLink, SyncNeighbour, SyncRow, SyncStore } from '../db/syncStore.js'
import { capText, DEFAULT_MAX_DOCUMENT_CHARS } from '../search/searchService.js'

/**
 * Incremental offline sync (R11, `GET /api/sync?since=<cursor>`). A cursor is
 * the decimal value of the server's change sequence; `0` asks for everything.
 * Each page is a consistent slice: every change up to `cursor` has been sent
 * once `hasMore` is false, and later changes come with the next call.
 */

export const DEFAULT_SYNC_LIMIT = 200
export const MAX_SYNC_LIMIT = 500

export interface SyncRequest {
  /** Cursor from the last response; 0 for a first sync. */
  since: number
  /** Pinned repos: only their files are sent. Notes (Obsidian, Keep, chats) always are. */
  repos: readonly string[]
  limit?: number
}

export interface SyncedDocument {
  id: number
  source: { kind: SearchableKind; name: string }
  path: string
  title: string
  language: string | null
  allowLlm: boolean
  mtime: Date | null
  updatedAt: Date
  content: string
  truncated: boolean
  /** Has a map vector (R20, T72): only map documents have neighbours and a local graph. */
  inMap: boolean
  /** Stored semantic neighbours, nearest first, at or above the Related cut-off. */
  neighbours: SyncNeighbour[]
  /** Link, tag, label and alias rows as stored; the device resolves them like the server. */
  links: SyncLink[]
}

export interface SyncResponse {
  /** Pass back as `since` next time. */
  cursor: string
  /** More changes are waiting below the same high-water mark: call again now. */
  hasMore: boolean
  /**
   * The client's cursor is ahead of the server (the database was restored or
   * rebuilt). Drop everything cached and sync again from `0`.
   */
  reset: boolean
  documents: SyncedDocument[]
  /** Ids the client must remove: deleted, disabled, or in a repo that is not pinned. */
  deleted: number[]
}

export interface SyncService {
  changes(request: SyncRequest): Promise<SyncResponse>
}

export interface SyncServiceOptions {
  store: SyncStore
  maxDocumentChars?: number
}

export function createSyncService(options: SyncServiceOptions): SyncService {
  const { store } = options
  const maxChars = options.maxDocumentChars ?? DEFAULT_MAX_DOCUMENT_CHARS

  const toDocument = (row: Extract<SyncRow, { type: 'upsert' }>['doc']): SyncedDocument => {
    const capped = capText(row.chunks.join('\n\n'), maxChars)
    return {
      id: row.id,
      source: { kind: row.sourceKind, name: row.sourceName },
      path: row.path,
      title: row.title,
      language: row.language,
      allowLlm: row.allowLlm,
      mtime: row.mtime,
      updatedAt: row.updatedAt,
      content: capped.text,
      truncated: capped.truncated,
      inMap: row.inMap,
      neighbours: row.neighbours,
      links: row.links,
    }
  }

  return {
    async changes(request) {
      const limit = Math.min(MAX_SYNC_LIMIT, Math.max(1, Math.trunc(request.limit ?? DEFAULT_SYNC_LIMIT)))
      const since = Math.max(0, Math.trunc(request.since))
      const upTo = await store.highWater()
      if (since > upTo) return { cursor: '0', hasMore: false, reset: true, documents: [], deleted: [] }

      const rows = await store.changes({ after: since, upTo, repos: [...new Set(request.repos)].sort(), limit })
      const hasMore = rows.length === limit
      const last = rows.at(-1)
      const cursor = hasMore && last !== undefined ? (last.type === 'upsert' ? last.doc.seq : last.seq) : upTo

      // A page can hold an id more than once only through a delete and a later
      // re-insert with a new id, so the latest row per id wins.
      const latest = new Map<number, SyncRow>()
      for (const row of rows) latest.set(row.type === 'upsert' ? row.doc.id : row.id, row)
      const documents: SyncedDocument[] = []
      const deleted: number[] = []
      for (const row of latest.values()) {
        if (row.type === 'upsert') documents.push(toDocument(row.doc))
        else deleted.push(row.id)
      }
      return { cursor: String(cursor), hasMore, reset: false, documents, deleted }
    },
  }
}

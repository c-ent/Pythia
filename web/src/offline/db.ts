import Dexie, { type EntityTable } from 'dexie'

/**
 * The browser's offline copy of the index (R11), in IndexedDB via Dexie.
 * Read-only: the server is the only writer, through `syncOnce` (sync.ts).
 * Obsidian, Keep, Drive and chat documents are always cached; repo files only
 * for pinned repos.
 */

export type CachedSourceKind = 'obsidian' | 'keep' | 'repo' | 'chat' | 'gdrive'

export interface CachedDocument {
  id: number
  sourceKind: CachedSourceKind
  sourceName: string
  path: string
  title: string
  language: string | null
  allowLlm: boolean
  /** ISO timestamps, as sent by the server. */
  mtime: string | null
  updatedAt: string
  content: string
  truncated: boolean
}

/** One row of sync state, under the key `SYNC_STATE_KEY`. */
export interface SyncState {
  key: string
  /** Server cursor after the last complete page. */
  cursor: string
  /** Pinned repos the cache was synced for, sorted. A different set means a fresh sync. */
  repos: string[]
  /** When the last sync finished, ISO. */
  syncedAt: string | null
}

export const SYNC_STATE_KEY = 'sync'

export class OfflineDb extends Dexie {
  documents!: EntityTable<CachedDocument, 'id'>
  state!: EntityTable<SyncState, 'key'>

  constructor(name = 'pythia') {
    super(name)
    this.version(1).stores({
      documents: 'id, [sourceKind+sourceName], updatedAt',
      state: 'key',
    })
  }
}

let shared: OfflineDb | null = null

/** The app's database, opened on first use. */
export function offlineDb(): OfflineDb {
  shared ??= new OfflineDb()
  return shared
}

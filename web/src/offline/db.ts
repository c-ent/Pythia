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

/** `links.kind` on the server (server/src/ingest/links.ts). `alias` rows are the note's own names. */
export type CachedLinkKind = 'wikilink' | 'embed' | 'markdown' | 'tag' | 'label' | 'alias'

export interface CachedLink {
  kind: CachedLinkKind
  /** As stored on the server: resolved on the device like the server does. */
  target: string
  heading: string | null
  display: string | null
}

export interface CachedNeighbour {
  id: number
  /** Cosine similarity of the two document vectors. */
  score: number
}

/**
 * The knowledge-map rows of one cached document (R20, T72), without its text,
 * so the offline Related list, backlinks and local graph read every note of a
 * source without loading every note's content. Written with the document.
 */
export interface CachedMapEntry {
  id: number
  sourceKind: CachedSourceKind
  sourceName: string
  path: string
  title: string
  allowLlm: boolean
  /** Has a map vector on the server: only map documents have neighbours and a graph. */
  inMap: boolean
  /** Stored neighbours, nearest first. */
  neighbours: CachedNeighbour[]
  /** Link, tag, label and alias rows in stored order (Obsidian and Keep notes). */
  links: CachedLink[]
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
  map!: EntityTable<CachedMapEntry, 'id'>

  constructor(name = 'pythia') {
    super(name)
    this.version(1).stores({
      documents: 'id, [sourceKind+sourceName], updatedAt',
      state: 'key',
    })
    // T72: map rows. Dropping the sync state makes the next sync start from
    // cursor 0, so documents cached before it get their map rows too.
    this.version(2)
      .stores({ map: 'id, [sourceKind+sourceName]' })
      .upgrade((tx) => tx.table('state').clear())
  }
}

let shared: OfflineDb | null = null

/** The app's database, opened on first use. */
export function offlineDb(): OfflineDb {
  shared ??= new OfflineDb()
  return shared
}

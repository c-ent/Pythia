import { apiFetch } from '../api/client'
import {
  SYNC_STATE_KEY,
  type CachedDocument,
  type CachedLink,
  type CachedMapEntry,
  type CachedNeighbour,
  type CachedSourceKind,
  type OfflineDb,
  type SyncState,
} from './db'

/** Shape of `GET /api/sync` (server/src/sync/syncService.ts). */
export interface SyncPage {
  cursor: string
  hasMore: boolean
  reset: boolean
  documents: Array<{
    id: number
    source: { kind: CachedSourceKind; name: string }
    path: string
    title: string
    language: string | null
    allowLlm: boolean
    mtime: string | null
    updatedAt: string
    content: string
    truncated: boolean
    /** Map rows (R20, T72); a server before T72 sends none, read as not in the map. */
    inMap?: boolean
    neighbours?: CachedNeighbour[]
    links?: CachedLink[]
  }>
  deleted: number[]
}

export interface SyncResult {
  /** Documents written (new or changed). */
  updated: number
  /** Documents removed from the cache. */
  removed: number
  /** Requests made, one per page. */
  pages: number
  /** The server asked for a full resync (restored database), so the cache was cleared first. */
  reset: boolean
  cursor: string
}

export interface SyncOptions {
  /** Repos whose files are cached offline. */
  pinnedRepos?: readonly string[]
  signal?: AbortSignal
  /** Page size; the server caps it. */
  limit?: number
  now?: () => Date
  /** Defaults to `GET /api/sync` through `apiFetch`. */
  fetchPage?: (query: URLSearchParams, signal?: AbortSignal) => Promise<SyncPage>
}

/** A runaway loop (a server that keeps saying `hasMore`) stops here. */
const MAX_PAGES = 10_000

async function defaultFetchPage(query: URLSearchParams, signal?: AbortSignal): Promise<SyncPage> {
  const res = await apiFetch(`/api/sync?${query.toString()}`, { signal })
  return (await res.json()) as SyncPage
}

const toCached = (doc: SyncPage['documents'][number]): CachedDocument => ({
  id: doc.id,
  sourceKind: doc.source.kind,
  sourceName: doc.source.name,
  path: doc.path,
  title: doc.title,
  language: doc.language,
  allowLlm: doc.allowLlm,
  mtime: doc.mtime,
  updatedAt: doc.updatedAt,
  content: doc.content,
  truncated: doc.truncated,
})

const toMapEntry = (doc: SyncPage['documents'][number]): CachedMapEntry => ({
  id: doc.id,
  sourceKind: doc.source.kind,
  sourceName: doc.source.name,
  path: doc.path,
  title: doc.title,
  allowLlm: doc.allowLlm,
  inMap: doc.inMap ?? false,
  neighbours: Array.isArray(doc.neighbours) ? doc.neighbours : [],
  links: Array.isArray(doc.links) ? doc.links : [],
})

export async function readSyncState(db: OfflineDb): Promise<SyncState | null> {
  return (await db.state.get(SYNC_STATE_KEY)) ?? null
}

/**
 * Pulls every change since the stored cursor into IndexedDB, page by page.
 * Each page and its cursor are written in one transaction, so an interrupted
 * sync (offline, tab closed) resumes where it stopped without gaps. Changing
 * the pinned repos restarts from cursor 0: unpinned repo files come back as
 * deletes and newly pinned ones as documents.
 */
export async function syncOnce(db: OfflineDb, options: SyncOptions = {}): Promise<SyncResult> {
  const fetchPage = options.fetchPage ?? defaultFetchPage
  const now = options.now ?? (() => new Date())
  const repos = [...new Set(options.pinnedRepos ?? [])].sort()
  const stored = await readSyncState(db)
  const sameRepos = stored !== null && stored.repos.join('\n') === repos.join('\n')
  let cursor = sameRepos ? stored.cursor : '0'
  const result: SyncResult = { updated: 0, removed: 0, pages: 0, reset: false, cursor }
  // Whether sync state exists that this run wrote or resumed from.
  let wrote = stored !== null

  for (;;) {
    options.signal?.throwIfAborted()
    if (result.pages >= MAX_PAGES) throw new Error('sync did not finish')
    const query = new URLSearchParams({ since: cursor })
    if (repos.length > 0) query.set('repos', repos.join(','))
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    const page = await fetchPage(query, options.signal)
    result.pages += 1

    if (page.reset) {
      if (result.reset) throw new Error('server asked for a reset twice')
      // The server's sequence is behind ours: the database was restored or
      // rebuilt. Start over so nothing stale survives.
      result.reset = true
      await db.transaction('rw', db.documents, db.map, db.state, async () => {
        await db.documents.clear()
        await db.map.clear()
        await db.state.put({ key: SYNC_STATE_KEY, cursor: '0', repos, syncedAt: null })
      })
      wrote = true
      cursor = '0'
      continue
    }

    const finished = !page.hasMore
    await db.transaction('rw', db.documents, db.map, db.state, async () => {
      // Clear offline cache ran while this sync was between pages: writing
      // this page's cursor would skip the pages it removed. Stop; the next
      // sync starts from cursor 0.
      if (wrote && (await readSyncState(db)) === null) throw new Error(CACHE_CLEARED)
      if (page.deleted.length > 0) {
        const present = await db.documents.bulkGet(page.deleted)
        result.removed += present.filter((doc) => doc !== undefined).length
        await db.documents.bulkDelete(page.deleted)
        await db.map.bulkDelete(page.deleted)
      }
      if (page.documents.length > 0) {
        // A document and its map rows are written together, so they never disagree.
        await db.documents.bulkPut(page.documents.map(toCached))
        await db.map.bulkPut(page.documents.map(toMapEntry))
      }
      result.updated += page.documents.length
      await db.state.put({
        key: SYNC_STATE_KEY,
        cursor: page.cursor,
        repos,
        syncedAt: finished ? now().toISOString() : (stored?.syncedAt ?? null),
      })
    })
    wrote = true
    cursor = page.cursor
    result.cursor = cursor
    if (finished) return result
  }
}

/** Message of the error `syncOnce` throws when the cache was cleared while it ran. */
export const CACHE_CLEARED = 'offline cache was cleared during sync'

/**
 * Removes every cached document and the sync state (Pinned page "Clear offline
 * cache", sign-out). The cursor goes with the state, so the next sync starts
 * from 0; a sync running at the time stops at its next page.
 */
export async function clearOfflineCache(db: OfflineDb): Promise<void> {
  await db.transaction('rw', db.documents, db.map, db.state, async () => {
    await db.documents.clear()
    await db.map.clear()
    await db.state.clear()
  })
}

/** Window event fired when this device's offline copy changed (an automatic sync, Clear offline cache). */
export const OFFLINE_CACHE_CHANGED = 'pythia:offline-cache'

export function offlineCacheChanged(): void {
  window.dispatchEvent(new Event(OFFLINE_CACHE_CHANGED))
}

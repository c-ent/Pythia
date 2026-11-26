import { apiFetch } from '../api/client'
import { SYNC_STATE_KEY, type CachedDocument, type CachedSourceKind, type OfflineDb, type SyncState } from './db'

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
      await db.transaction('rw', db.documents, db.state, async () => {
        await db.documents.clear()
        await db.state.put({ key: SYNC_STATE_KEY, cursor: '0', repos, syncedAt: null })
      })
      cursor = '0'
      continue
    }

    const finished = !page.hasMore
    await db.transaction('rw', db.documents, db.state, async () => {
      if (page.deleted.length > 0) {
        const present = await db.documents.bulkGet(page.deleted)
        result.removed += present.filter((doc) => doc !== undefined).length
        await db.documents.bulkDelete(page.deleted)
      }
      if (page.documents.length > 0) await db.documents.bulkPut(page.documents.map(toCached))
      result.updated += page.documents.length
      await db.state.put({
        key: SYNC_STATE_KEY,
        cursor: page.cursor,
        repos,
        syncedAt: finished ? now().toISOString() : (stored?.syncedAt ?? null),
      })
    })
    cursor = page.cursor
    result.cursor = cursor
    if (finished) return result
  }
}

/** Removes every cached document and the sync state (for sign-out or a storage reset). */
export async function clearOfflineCache(db: OfflineDb): Promise<void> {
  await db.transaction('rw', db.documents, db.state, async () => {
    await db.documents.clear()
    await db.state.clear()
  })
}

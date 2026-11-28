import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb } from './db'
import { CACHE_CLEARED, clearOfflineCache, readSyncState, syncOnce, type SyncPage } from './sync'

type PageDoc = SyncPage['documents'][number]
type ServerDoc = PageDoc & { seq: number }

const withoutSeq = (doc: ServerDoc): PageDoc => {
  const copy: Partial<ServerDoc> = { ...doc }
  delete copy.seq
  return copy as PageDoc
}

/**
 * A tiny stand-in for `GET /api/sync` with the server's rules: one change
 * sequence, tombstones, repo files only when pinned, pages of `limit`.
 */
function fakeServer() {
  let seq = 0
  const docs = new Map<number, ServerDoc>()
  const tombstones: Array<{ seq: number; id: number }> = []
  const requests: string[] = []

  const put = (id: number, path: string, content: string, kind: 'obsidian' | 'repo' = 'obsidian', name = 'vault') => {
    seq += 1
    docs.set(id, {
      seq,
      id,
      source: { kind, name },
      path,
      title: path,
      language: null,
      allowLlm: true,
      mtime: null,
      updatedAt: '2026-11-20T10:00:00.000Z',
      content,
      truncated: false,
    })
  }
  const remove = (id: number) => {
    docs.delete(id)
    seq += 1
    tombstones.push({ seq, id })
  }

  const fetchPage = async (query: URLSearchParams): Promise<SyncPage> => {
    requests.push(query.toString())
    const since = Number(query.get('since') ?? '0')
    const limit = Number(query.get('limit') ?? '200')
    const repos = (query.get('repos') ?? '').split(',').filter(Boolean)
    if (since > seq) return { cursor: '0', hasMore: false, reset: true, documents: [], deleted: [] }
    const rows: Array<{ seq: number; doc?: ServerDoc; id: number }> = []
    for (const doc of docs.values()) {
      if (doc.seq <= since) continue
      const visible = doc.source.kind !== 'repo' || repos.includes(doc.source.name)
      rows.push(visible ? { seq: doc.seq, doc, id: doc.id } : { seq: doc.seq, id: doc.id })
    }
    for (const stone of tombstones) if (stone.seq > since) rows.push(stone)
    rows.sort((a, b) => a.seq - b.seq)
    const page = rows.slice(0, limit)
    const hasMore = page.length === limit && rows.length > limit
    return {
      cursor: String(hasMore ? (page.at(-1)?.seq ?? seq) : seq),
      hasMore,
      reset: false,
      documents: page.flatMap((row) => (row.doc === undefined ? [] : [withoutSeq(row.doc)])),
      deleted: page.filter((row) => row.doc === undefined).map((row) => row.id),
    }
  }

  return { put, remove, fetchPage, requests, rewind: () => (seq = 0) }
}

describe('offline sync store', () => {
  let db: OfflineDb
  let name: string
  const now = () => new Date('2026-11-26T01:00:00Z')

  beforeEach(() => {
    name = `pythia-test-${Math.random().toString(36).slice(2)}`
    db = new OfflineDb(name)
  })

  afterEach(async () => {
    db.close()
    await OfflineDb.delete(name)
  })

  const paths = async () => (await db.documents.orderBy('id').toArray()).map((doc) => doc.path)

  it('fills IndexedDB with every note on the first sync', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A')
    server.put(2, 'B.md', '# B')
    const result = await syncOnce(db, { fetchPage: server.fetchPage, now })
    expect(result).toEqual({ updated: 2, removed: 0, pages: 1, reset: false, cursor: '2' })
    expect(await paths()).toEqual(['A.md', 'B.md'])
    expect(await db.documents.get(1)).toMatchObject({ sourceKind: 'obsidian', sourceName: 'vault', content: '# A' })
    expect(await readSyncState(db)).toEqual({ key: 'sync', cursor: '2', repos: [], syncedAt: '2026-11-26T01:00:00.000Z' })
  })

  it('stores map rows with each document and drops them with it (T72)', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A [[B]]')
    server.put(2, 'B.md', '# B')
    const links = [{ kind: 'wikilink' as const, target: 'B', heading: null, display: null }]
    const fetchPage = async (query: URLSearchParams): Promise<SyncPage> => {
      const page = await server.fetchPage(query)
      return {
        ...page,
        documents: page.documents.map((doc) =>
          doc.id === 1 ? { ...doc, inMap: true, neighbours: [{ id: 2, score: 0.8 }], links } : doc,
        ),
      }
    }
    await syncOnce(db, { fetchPage, now })
    expect(await db.map.get(1)).toEqual({
      id: 1,
      sourceKind: 'obsidian',
      sourceName: 'vault',
      path: 'A.md',
      title: 'A.md',
      allowLlm: true,
      inMap: true,
      neighbours: [{ id: 2, score: 0.8 }],
      links,
    })
    // A server before T72 sends no map fields: read as not in the map.
    expect(await db.map.get(2)).toMatchObject({ inMap: false, neighbours: [], links: [] })

    server.remove(1)
    await syncOnce(db, { fetchPage, now })
    expect(await db.map.get(1)).toBeUndefined()

    await clearOfflineCache(db)
    expect(await db.map.count()).toBe(0)
  })

  it('then asks only for changes after its cursor', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A')
    server.put(2, 'B.md', '# B')
    await syncOnce(db, { fetchPage: server.fetchPage, now })

    server.put(1, 'A.md', '# A edited')
    server.remove(2)
    server.put(3, 'C.md', '# C')
    const result = await syncOnce(db, { fetchPage: server.fetchPage, now })
    expect(server.requests.at(-1)).toBe('since=2')
    expect(result).toMatchObject({ updated: 2, removed: 1, cursor: '5' })
    expect(await paths()).toEqual(['A.md', 'C.md'])
    expect((await db.documents.get(1))?.content).toBe('# A edited')
  })

  it('follows pages until the server has nothing more', async () => {
    const server = fakeServer()
    for (let id = 1; id <= 7; id++) server.put(id, `N${id}.md`, 'x')
    const result = await syncOnce(db, { fetchPage: server.fetchPage, limit: 3, now })
    expect(result.pages).toBe(3)
    expect(await db.documents.count()).toBe(7)
    expect(server.requests).toEqual(['since=0&limit=3', 'since=3&limit=3', 'since=6&limit=3'])
  })

  it('resumes after an interrupted sync without losing a page', async () => {
    const server = fakeServer()
    for (let id = 1; id <= 6; id++) server.put(id, `N${id}.md`, 'x')
    let calls = 0
    const flaky = async (query: URLSearchParams) => {
      calls += 1
      if (calls === 2) throw new Error('offline')
      return server.fetchPage(query)
    }
    await expect(syncOnce(db, { fetchPage: flaky, limit: 3, now })).rejects.toThrow('offline')
    expect(await readSyncState(db)).toMatchObject({ cursor: '3', syncedAt: null })
    expect(await db.documents.count()).toBe(3)

    await syncOnce(db, { fetchPage: server.fetchPage, limit: 3, now })
    expect(server.requests.at(-1)).toBe('since=3&limit=3')
    expect(await db.documents.count()).toBe(6)
  })

  it('caches pinned repo files and drops them when the repo is unpinned', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A')
    server.put(10, 'src/cart.ts', 'export {}', 'repo', 'kitchen-app')
    await syncOnce(db, { fetchPage: server.fetchPage, now })
    expect(await paths()).toEqual(['A.md'])

    await syncOnce(db, { fetchPage: server.fetchPage, pinnedRepos: ['kitchen-app'], now })
    expect(server.requests.at(-1)).toBe('since=0&repos=kitchen-app')
    expect(await paths()).toEqual(['A.md', 'src/cart.ts'])

    const unpinned = await syncOnce(db, { fetchPage: server.fetchPage, pinnedRepos: [], now })
    expect(unpinned.removed).toBe(1)
    expect(await paths()).toEqual(['A.md'])
  })

  it('clears the cache and starts over when the server was reset', async () => {
    const server = fakeServer()
    server.put(1, 'Old.md', 'old')
    await syncOnce(db, { fetchPage: server.fetchPage, now })
    // The server database was rebuilt: its sequence starts again.
    server.rewind()
    server.remove(1)
    server.put(2, 'New.md', 'new')
    await db.state.update('sync', { cursor: '50' })
    const result = await syncOnce(db, { fetchPage: server.fetchPage, now })
    expect(result.reset).toBe(true)
    expect(await paths()).toEqual(['New.md'])
  })

  it('stops when the signal is aborted', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A')
    const controller = new AbortController()
    controller.abort()
    const fetchPage = vi.fn(server.fetchPage)
    await expect(syncOnce(db, { fetchPage, signal: controller.signal })).rejects.toThrow()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('clears everything on request', async () => {
    const server = fakeServer()
    server.put(1, 'A.md', '# A')
    await syncOnce(db, { fetchPage: server.fetchPage, now })
    await clearOfflineCache(db)
    expect(await db.documents.count()).toBe(0)
    expect(await readSyncState(db)).toBeNull()
  })

  it('stops a running sync when the cache is cleared, and the next one starts from 0', async () => {
    const server = fakeServer()
    for (let id = 1; id <= 6; id++) server.put(id, `N${id}.md`, 'x')
    let calls = 0
    const clearing = async (query: URLSearchParams) => {
      calls += 1
      // Clear offline cache is pressed while the second page is on its way.
      if (calls === 2) await clearOfflineCache(db)
      return server.fetchPage(query)
    }
    await expect(syncOnce(db, { fetchPage: clearing, limit: 3, now })).rejects.toThrow(CACHE_CLEARED)
    expect(await db.documents.count()).toBe(0)
    expect(await readSyncState(db)).toBeNull()

    await syncOnce(db, { fetchPage: server.fetchPage, limit: 3, now })
    expect(server.requests.at(-2)).toBe('since=0&limit=3')
    expect(await db.documents.count()).toBe(6)
  })

  it('uses GET /api/sync by default', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ cursor: '0', hasMore: false, reset: false, documents: [], deleted: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await syncOnce(db, { pinnedRepos: ['b', 'a'] })
    expect(fetchMock).toHaveBeenCalledWith('/api/sync?since=0&repos=a%2Cb', expect.objectContaining({ credentials: 'same-origin' }))
  })
})

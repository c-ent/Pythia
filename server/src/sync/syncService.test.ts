import { describe, expect, it } from 'vitest'
import { createMemorySyncStore, type MemorySyncStore } from './memorySyncStore.js'
import { createSyncService, MAX_SYNC_LIMIT, type SyncResponse, type SyncService } from './syncService.js'

const at = new Date('2026-11-20T10:00:00Z')

function note(store: MemorySyncStore, id: number, path: string, chunks: string[] = [`# ${path}`]) {
  return store.put({
    id,
    sourceKind: 'obsidian',
    sourceName: 'vault',
    path,
    title: path,
    language: null,
    allowLlm: true,
    mtime: at,
    updatedAt: at,
    chunks,
  })
}

function repoFile(store: MemorySyncStore, id: number, repo: string, path: string) {
  return store.put({
    id,
    sourceKind: 'repo',
    sourceName: repo,
    path,
    title: path,
    language: 'typescript',
    allowLlm: true,
    mtime: null,
    updatedAt: at,
    chunks: [`// ${path}`],
  })
}

/** Follows `hasMore` like the client does and returns every page. */
async function drain(sync: SyncService, since: string, repos: string[] = [], limit?: number): Promise<SyncResponse[]> {
  const pages: SyncResponse[] = []
  let cursor = since
  for (;;) {
    const page = await sync.changes({ since: Number(cursor), repos, limit })
    pages.push(page)
    cursor = page.cursor
    if (!page.hasMore) return pages
  }
}

describe('sync service', () => {
  it('sends everything on a first sync and nothing after', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'A.md', ['# A', 'Second section'])
    note(store, 2, 'B.md')
    const sync = createSyncService({ store })

    const first = await sync.changes({ since: 0, repos: [] })
    expect(first.hasMore).toBe(false)
    expect(first.reset).toBe(false)
    expect(first.cursor).toBe('2')
    expect(first.deleted).toEqual([])
    expect(first.documents.map((doc) => [doc.id, doc.path])).toEqual([
      [1, 'A.md'],
      [2, 'B.md'],
    ])
    expect(first.documents[0]).toMatchObject({
      source: { kind: 'obsidian', name: 'vault' },
      content: '# A\n\nSecond section',
      truncated: false,
    })

    expect(await sync.changes({ since: 2, repos: [] })).toEqual({
      cursor: '2',
      hasMore: false,
      reset: false,
      documents: [],
      deleted: [],
    })
  })

  it('sends only what changed since the cursor, including deletes', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'A.md')
    note(store, 2, 'B.md')
    const sync = createSyncService({ store })
    const { cursor } = await sync.changes({ since: 0, repos: [] })

    note(store, 1, 'A.md', ['# A edited'])
    note(store, 3, 'C.md')
    store.remove(2)

    const next = await sync.changes({ since: Number(cursor), repos: [] })
    expect(next.documents.map((doc) => [doc.id, doc.content])).toEqual([
      [1, '# A edited'],
      [3, '# C.md'],
    ])
    expect(next.deleted).toEqual([2])
    expect(next.cursor).toBe('5')
  })

  it('pages through large changes without losing or repeating any', async () => {
    const store = createMemorySyncStore()
    for (let id = 1; id <= 25; id++) note(store, id, `N${id}.md`)
    store.remove(4)
    const sync = createSyncService({ store })

    const pages = await drain(sync, '0', [], 10)
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false])
    const ids = pages.flatMap((page) => page.documents.map((doc) => doc.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(24)
    expect(ids).not.toContain(4)
    expect(pages.flatMap((page) => page.deleted)).toEqual([4])
    expect(pages.at(-1)?.cursor).toBe('26')
  })

  it('sends repo files only for pinned repos and drops them when unpinned', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'A.md')
    repoFile(store, 10, 'kitchen-app', 'src/cart.ts')
    repoFile(store, 11, 'launcher', 'src/rocket.ts')
    const sync = createSyncService({ store })

    const pinned = await sync.changes({ since: 0, repos: ['kitchen-app'] })
    expect(pinned.documents.map((doc) => doc.id)).toEqual([1, 10])
    // Never sent, so the client holds nothing to remove; a delete is harmless.
    expect(pinned.deleted).toEqual([11])

    // Unpinning is a fresh sync from 0 for that repo set: its files come back as deletes.
    const unpinned = await sync.changes({ since: 0, repos: [] })
    expect(unpinned.documents.map((doc) => doc.id)).toEqual([1])
    expect(unpinned.deleted).toEqual([10, 11])
  })

  it('reports disabled and work sources as removed, never their text', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'A.md')
    store.put({
      id: 2,
      sourceKind: 'work',
      sourceName: 'employer',
      path: 'memo.md',
      title: 'memo',
      language: null,
      allowLlm: true,
      mtime: null,
      updatedAt: at,
      chunks: ['employer secret'],
    })
    const sync = createSyncService({ store })
    const first = await sync.changes({ since: 0, repos: [] })
    expect(JSON.stringify(first)).not.toContain('employer secret')
    expect(first.deleted).toEqual([2])

    store.setEnabled('obsidian', 'vault', false)
    const next = await sync.changes({ since: Number(first.cursor), repos: [] })
    expect(next.documents).toEqual([])
    expect(next.deleted).toEqual([1])
  })

  it('asks the client to start over when its cursor is ahead of the server', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'A.md')
    const sync = createSyncService({ store })
    expect(await sync.changes({ since: 99, repos: [] })).toEqual({
      cursor: '0',
      hasMore: false,
      reset: true,
      documents: [],
      deleted: [],
    })
  })

  it('caps document text and the page size', async () => {
    const store = createMemorySyncStore()
    note(store, 1, 'Big.md', ['x'.repeat(500)])
    const sync = createSyncService({ store, maxDocumentChars: 100 })
    const page = await sync.changes({ since: 0, repos: [], limit: MAX_SYNC_LIMIT * 10 })
    expect(page.documents[0]?.content).toHaveLength(100)
    expect(page.documents[0]?.truncated).toBe(true)
  })

  it('works on an empty index', async () => {
    const sync = createSyncService({ store: createMemorySyncStore() })
    expect(await sync.changes({ since: 0, repos: [] })).toEqual({
      cursor: '0',
      hasMore: false,
      reset: false,
      documents: [],
      deleted: [],
    })
  })
})

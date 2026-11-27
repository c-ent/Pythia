import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb, SYNC_STATE_KEY, type CachedDocument } from '../offline/db'
import { readSyncState } from '../offline/sync'
import { PINS_KEY, readPinnedRepos } from '../repos/pins'
import { resetSyncNow } from '../sources/syncNow'
import { CLEAR_DONE_MESSAGE, PERSIST_REFUSED_MESSAGE } from './pinned'
import { PinnedScreen } from './PinnedScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const doc = (id: number, sourceKind: CachedDocument['sourceKind'], sourceName: string, content: string): CachedDocument => ({
  id,
  sourceKind,
  sourceName,
  path: `file-${id}`,
  title: `File ${id}`,
  language: null,
  allowLlm: true,
  mtime: null,
  updatedAt: '2026-11-26T00:00:00.000Z',
  content,
  truncated: false,
})

// jsdom has no `navigator.storage`; each test defines the one it needs.
function stubStorage(storage: Partial<StorageManager>): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, get: () => storage })
}

const statusBody = {
  reachable: true,
  checkedAt: '2026-11-27T08:00:00.000Z',
  gemini: { available: true },
  devices: { active: 1 },
  documents: { obsidian: 2, keep: 0, repo: 1, chat: 0 },
  syncing: false,
  sources: [],
  repos: [],
  activity: [],
}

const fetchMock = vi.fn(async (url: string) => {
  if (url === '/api/sync-now') return json(202, { started: true, vault: 'started', repos: 'started' })
  if (url === '/api/status') return json(200, statusBody)
  if (url.startsWith('/api/sync?')) return json(200, { cursor: '9', hasMore: false, reset: false, documents: [], deleted: [] })
  return json(404, { error: { code: 'not_found', message: 'Not found' } })
})

async function seed(): Promise<void> {
  const db = offlineDb()
  await db.documents.bulkPut([
    doc(1, 'obsidian', 'vault', 'a'.repeat(2048)),
    doc(2, 'keep', 'keep', 'b'.repeat(1024)),
    doc(3, 'repo', 'alpha', 'c'.repeat(3 * 1024)),
  ])
  await db.state.put({ key: SYNC_STATE_KEY, cursor: '9', repos: ['alpha'], syncedAt: '2026-11-27T07:42:00.000Z' })
}

describe('PinnedScreen', () => {
  beforeEach(async () => {
    localStorage.clear()
    resetSyncNow()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
    const db = offlineDb()
    await db.documents.clear()
    await db.state.clear()
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'storage')
    vi.restoreAllMocks()
  })

  it('lists pinned repos with their cached size and status', async () => {
    stubStorage({})
    localStorage.setItem(PINS_KEY, JSON.stringify(['alpha', 'beta']))
    await seed()
    render(<PinnedScreen />)
    const list = screen.getByRole('region', { name: 'Pinned repos' })
    const alpha = (await within(list).findByText('alpha')).closest('li') as HTMLElement
    expect(await within(alpha).findByText('Cached')).toBeTruthy()
    expect(within(alpha).getByText('1 file · 3.0 KB')).toBeTruthy()
    const beta = within(list).getByText('beta').closest('li') as HTMLElement
    expect(within(beta).getByText('Waiting for sync')).toBeTruthy()
    expect(within(beta).getByText('No files cached')).toBeTruthy()
  })

  it('unpins a repo', async () => {
    stubStorage({})
    localStorage.setItem(PINS_KEY, JSON.stringify(['alpha', 'beta']))
    render(<PinnedScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Unpin alpha' }))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(readPinnedRepos()).toEqual(['beta'])
  })

  it('points to the Repos page when nothing is pinned', () => {
    stubStorage({})
    render(<PinnedScreen />)
    expect(screen.getByText(/No repos pinned yet/)).toBeTruthy()
  })

  it('shows storage use, the breakdown and persistent storage', async () => {
    stubStorage({
      estimate: () => Promise.resolve({ usage: 6.4 * 1024 * 1024, quota: 50 * 1024 * 1024 }),
      persisted: () => Promise.resolve(true),
    })
    await seed()
    render(<PinnedScreen />)
    expect(await screen.findByText('6.4 MB used')).toBeTruthy()
    expect(screen.getByText('of 50 MB the browser allows')).toBeTruthy()
    expect(screen.getByText('Notes · 2')).toBeTruthy()
    expect(screen.getByText('Repo files · 1')).toBeTruthy()
    expect(screen.getByText('Granted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep offline data' })).toBeNull()
  })

  it('says when storage details are unknown', async () => {
    stubStorage({})
    render(<PinnedScreen />)
    expect(await screen.findByText('Persistent storage')).toBeTruthy()
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
  })

  it('asks the browser to keep offline data and explains a refusal', async () => {
    const persist = vi.fn(() => Promise.resolve(false))
    stubStorage({ persisted: () => Promise.resolve(false), persist })
    render(<PinnedScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep offline data' }))
    expect(await screen.findByText(PERSIST_REFUSED_MESSAGE)).toBeTruthy()
    expect(persist).toHaveBeenCalledOnce()
  })

  it('shows persistence once granted', async () => {
    stubStorage({ persisted: () => Promise.resolve(false), persist: () => Promise.resolve(true) })
    render(<PinnedScreen />)
    expect(await screen.findByText('Not granted')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep offline data' }))
    expect(await screen.findByText('Granted')).toBeTruthy()
  })

  it('clears the offline cache after confirming: IndexedDB is emptied and the cursor reset', async () => {
    stubStorage({})
    localStorage.setItem(PINS_KEY, JSON.stringify(['alpha']))
    await seed()
    render(<PinnedScreen />)
    // The button is disabled until the cache has been read.
    const clearButton = (await screen.findByRole('button', { name: 'Clear offline cache' })) as HTMLButtonElement
    await waitFor(() => expect(clearButton.disabled).toBe(false))
    fireEvent.click(clearButton)
    // Cancel keeps everything.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await offlineDb().documents.count()).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'Clear offline cache' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(await screen.findByText(CLEAR_DONE_MESSAGE)).toBeTruthy()
    expect(await offlineDb().documents.count()).toBe(0)
    expect(await readSyncState(offlineDb())).toBeNull()
    // Pins are kept; the repo now waits for the next sync.
    expect(readPinnedRepos()).toEqual(['alpha'])
    expect(await screen.findByText('Waiting for sync')).toBeTruthy()
    expect(screen.getByText('Notes · 0')).toBeTruthy()
  })

  it('disables Clear when there is nothing cached', async () => {
    stubStorage({})
    render(<PinnedScreen />)
    const button = await screen.findByRole('button', { name: 'Clear offline cache' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true))
  })

  it('updates all now: the server syncs, then this device', async () => {
    stubStorage({})
    render(<PinnedScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Update all now' }))
    expect(await screen.findByText('Up to date.')).toBeTruthy()
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain('/api/sync-now')
    expect(urls.some((url) => url.startsWith('/api/sync?since='))).toBe(true)
  })

  it('disables Update all now offline and calls nothing', () => {
    stubStorage({})
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<PinnedScreen />)
    const button = screen.getByRole('button', { name: 'Update all now' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Updating needs a connection.')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

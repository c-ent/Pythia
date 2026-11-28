import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheCounts } from '../offline/storage'
import { readCacheCounts, readStorageInfo } from '../offline/storage'
import { syncOnce } from '../offline/sync'
import { offlineSummary } from '../sources/format'
import { resetSyncNow, startSyncNow } from '../sources/syncNow'
import { OfflineCard, OfflineRailButton } from './OfflineCard'

// This device's copy is read from IndexedDB, which jsdom lacks: the cache
// reads and the pull are stubbed, the rest of the modules stay real.
vi.mock('../offline/db', () => ({ offlineDb: () => ({}) }))
vi.mock('../offline/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offline/sync')>()),
  syncOnce: vi.fn(async () => {}),
}))
vi.mock('../offline/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../offline/storage')>()),
  readCacheCounts: vi.fn(),
  readStorageInfo: vi.fn(),
}))

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const statusBody = (over: Record<string, unknown> = {}) => ({
  reachable: true,
  checkedAt: '2026-11-27T08:00:00.000Z',
  gemini: { available: true },
  devices: { active: 2 },
  documents: { obsidian: 48, keep: 3, repo: 120, chat: 0 },
  syncing: false,
  sources: [],
  repos: [],
  activity: [],
  ...over,
})

type Handler = () => Response | Promise<Response>

/** Routes are keyed `METHOD url`; anything else answers 404. */
function stubApi(routes: Record<string, Handler>) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push(key)
    const route = routes[key]
    return route === undefined ? json(404, { error: { code: 'not_found', message: 'Not found' } }) : route()
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

const counts = (over: Partial<CacheCounts> = {}): CacheCounts => ({
  notes: 48,
  repoFiles: 120,
  syncedAt: '2026-11-27T07:42:00.000Z',
  ...over,
})

const syncButton = () => screen.getByRole('button', { name: /Sync now|Syncing…/ }) as HTMLButtonElement

describe('offlineSummary', () => {
  const now = new Date('2026-11-27T12:00:00')

  it('lists cached notes, pinned repos, size and the last sync', () => {
    expect(offlineSummary(counts({ syncedAt: '2026-11-02T09:00:00' }), 6, 6.4 * 1024 * 1024, now)).toBe(
      '48 notes, 6 repos cached · 6.4 MB. Synced Nov 2.',
    )
  })

  it('leaves out an unknown size and says when this device never synced', () => {
    expect(offlineSummary(counts({ notes: 1, syncedAt: null }), 1, null, now)).toBe(
      '1 note, 1 repo cached. Not synced on this device yet.',
    )
  })
})

describe('OfflineCard', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', {})
    vi.mocked(readCacheCounts).mockResolvedValue(counts())
    vi.mocked(readStorageInfo).mockResolvedValue({ usage: 6.4 * 1024 * 1024, quota: null, persisted: null })
  })

  afterEach(() => {
    resetSyncNow()
    vi.mocked(syncOnce).mockClear()
    vi.restoreAllMocks()
  })

  it('shows what this device has cached', async () => {
    stubApi({})
    render(<OfflineCard online pinned={6} />)
    expect(screen.getByRole('heading', { name: 'Offline ready' })).toBeTruthy()
    expect(await screen.findByText(/48 notes, 6 repos cached · 6\.4 MB\. Synced /)).toBeTruthy()
    expect(syncButton().disabled).toBe(false)
  })

  it('says when this browser cannot keep an offline copy', async () => {
    vi.stubGlobal('indexedDB', undefined)
    stubApi({})
    render(<OfflineCard online pinned={0} />)
    expect(await screen.findByText('This browser can’t keep an offline copy.')).toBeTruthy()
  })

  it('disables Sync now offline and calls nothing', async () => {
    const { fn } = stubApi({})
    render(<OfflineCard online={false} pinned={6} />)
    expect(screen.getByRole('heading', { name: 'You’re offline' })).toBeTruthy()
    expect(screen.getByText('Sync now needs a connection.')).toBeTruthy()
    expect(syncButton().disabled).toBe(true)
    fireEvent.click(syncButton())
    await screen.findByText(/48 notes/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('syncs the server, then this device, and rereads the cache', async () => {
    let release: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const { calls } = stubApi({
      'POST /api/sync-now': async () => {
        await started
        return json(202, { started: true, vault: 'started', repos: 'started' })
      },
      'GET /api/status': () => json(200, statusBody()),
    })
    render(<OfflineCard online pinned={6} />)
    await screen.findByText(/48 notes/)
    vi.mocked(readCacheCounts).mockResolvedValue(counts({ notes: 50 }))

    fireEvent.click(syncButton())
    expect(await screen.findByText('Syncing the server…')).toBeTruthy()
    expect(syncButton().textContent).toBe('Syncing…')
    expect(syncButton().disabled).toBe(true)

    // A second press while the run is on starts nothing new.
    await startSyncNow()
    expect(calls.filter((call) => call === 'POST /api/sync-now')).toHaveLength(1)

    release()
    expect(await screen.findByText('Up to date.')).toBeTruthy()
    expect(syncOnce).toHaveBeenCalledOnce()
    expect(calls).toEqual(['POST /api/sync-now', 'GET /api/status'])
    expect(await screen.findByText(/50 notes, 6 repos cached/)).toBeTruthy()
    expect(syncButton().disabled).toBe(false)
  })

  it('shows a failed Sync now and lets it be pressed again', async () => {
    stubApi({ 'POST /api/sync-now': () => json(500, { error: { code: 'internal', message: 'Internal server error' } }) })
    render(<OfflineCard online pinned={6} />)
    fireEvent.click(syncButton())
    expect(await screen.findByText('Sync now failed. Try again.')).toBeTruthy()
    expect(syncOnce).not.toHaveBeenCalled()
    await waitFor(() => expect(syncButton().disabled).toBe(false))
  })

  it('says when the server has no Sync now yet', async () => {
    stubApi({})
    render(<OfflineCard online pinned={6} />)
    fireEvent.click(syncButton())
    expect(await screen.findByText('Sync now isn’t available on this server yet.')).toBeTruthy()
  })

  it('shows Syncing… when the server is already syncing in the background', () => {
    render(<OfflineCard online pinned={6} syncing progress="Syncing the server… 40%" />)
    expect(syncButton().textContent).toBe('Syncing…')
    expect(syncButton().disabled).toBe(true)
    expect(screen.getByText('Syncing the server… 40%')).toBeTruthy()
  })
})

describe('OfflineRailButton', () => {
  afterEach(() => resetSyncNow())

  it('is one labelled button, disabled offline or while syncing', () => {
    const { rerender } = render(<OfflineRailButton online />)
    const button = screen.getByRole('button', { name: 'Offline ready. Sync now' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    rerender(<OfflineRailButton online syncing />)
    expect((screen.getByRole('button', { name: 'Syncing…' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<OfflineRailButton online={false} />)
    expect(
      (screen.getByRole('button', { name: 'You’re offline. Sync now needs a connection' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

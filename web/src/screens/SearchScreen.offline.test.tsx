import 'fake-indexeddb/auto'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { offlineDb, SYNC_STATE_KEY } from '../offline/db'
import { SearchScreen } from './SearchScreen'

// With IndexedDB available and the browser offline, Search answers from the
// documents cached on this device instead of calling the server (R11).
describe('SearchScreen offline', () => {
  beforeEach(async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const db = offlineDb()
    await db.documents.clear()
    await db.documents.bulkPut([
      {
        id: 1,
        sourceKind: 'obsidian',
        sourceName: 'vault',
        path: 'Kitchen/Sourdough.md',
        title: 'Sourdough',
        language: null,
        allowLlm: true,
        mtime: null,
        updatedAt: '2026-11-26T00:00:00.000Z',
        content: 'Feed the starter with flour and water every morning.',
        truncated: false,
      },
      {
        id: 2,
        sourceKind: 'repo',
        sourceName: 'kitchen-app',
        path: 'src/auth.ts',
        title: 'auth.ts',
        language: 'typescript',
        allowLlm: true,
        mtime: null,
        updatedAt: '2026-11-26T00:00:00.000Z',
        content: 'export function login() {}',
        truncated: false,
      },
    ])
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '2', repos: ['kitchen-app'], syncedAt: null })
  })

  afterEach(() => vi.restoreAllMocks())

  function search(text: string) {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
  }

  it('finds a cached note without calling the server', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<SearchScreen />)
    search('starter')
    const card = await screen.findByRole('article')
    expect(within(card).getByText('Sourdough')).toBeTruthy()
    expect(screen.getByText(/You’re offline. Showing word matches/)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('finds a pinned repo file', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<SearchScreen />)
    search('login')
    expect(within(await screen.findByRole('article')).getByText('auth.ts')).toBeTruthy()
  })

  it('says when nothing cached matches', async () => {
    vi.stubGlobal('fetch', vi.fn())
    render(<SearchScreen />)
    search('passport')
    expect(await screen.findByText('No matches for “passport”')).toBeTruthy()
  })
})

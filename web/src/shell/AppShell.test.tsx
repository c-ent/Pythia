import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'
import { SIDEBAR_KEY } from './nav'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function statusPayload(health: 'ok' | 'warning' | 'broken' = 'ok') {
  return {
    reachable: true,
    checkedAt: '2026-11-28T00:00:00.000Z',
    gemini: { available: true },
    devices: { active: 1 },
    documents: { obsidian: 1, keep: 0, repo: 0, chat: 0, gdrive: 0 },
    syncing: false,
    health,
    sources: [],
    repos: [],
    activity: [],
  }
}

function serverDetailsPayload(checks: Record<string, { state: 'ok' | 'broken' | 'off'; reason: string | null }>) {
  return {
    sampledAt: '2026-11-28T00:00:00.000Z',
    checkedAt: '2026-11-28T00:00:00.000Z',
    health: 'broken',
    cpu: { cores: 4, loadAverage: [0.1, 0.2, 0.3], busyPercent: 10 },
    memory: { totalBytes: 1000, availableBytes: 500, usedBytes: 500 },
    disk: { totalBytes: 2000, freeBytes: 1000, usedBytes: 1000 },
    databaseBytes: 100,
    uptimeSeconds: { host: 1000, app: 100 },
    version: { app: '1.0.0', commit: null },
    checks,
  }
}

// jsdom applies no CSS, so the sidebar, the rail and the phone tab bar are all
// in the tree; each test picks the layout it means.
function layout(name: 'desktop' | 'tablet' | 'mobile' | 'topbar' | 'mobile-top'): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-layout="${name}"]`)
  if (element === null) throw new Error(`No ${name} layout`)
  return element
}

const nav = () => within(within(layout('desktop')).getByRole('navigation', { name: 'Main' }))
const labels = (scope: HTMLElement) => within(scope).getAllByRole('link').map((link) => link.textContent)

describe('AppShell', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('lists the screens and marks the current one', () => {
    render(<AppShell onSignOut={() => {}} />)
    expect(nav().getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Search',
      'Ask',
      'Repos',
      'Pinned',
      'Map',
      'Sources',
      'Settings',
    ])
    expect(nav().getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
    expect(document.title).toBe('Search · Pythia')
  })

  it('gives the rail every screen and the phone tab bar all but Map and Sources', () => {
    render(<AppShell onSignOut={() => {}} />)
    expect(labels(within(layout('tablet')).getByRole('navigation', { name: 'Main' }))).toEqual([
      'Search',
      'Ask',
      'Repos',
      'Pinned',
      'Map',
      'Sources',
      'Settings',
    ])
    expect(labels(layout('mobile'))).toEqual(['Search', 'Ask', 'Repos', 'Pinned', 'Settings'])
  })

  it('navigates without a page load and follows back', () => {
    render(<AppShell onSignOut={() => {}} />)
    fireEvent.click(nav().getByRole('link', { name: 'Repos' }))
    expect(window.location.pathname).toBe('/repos')
    expect(nav().getByRole('link', { name: 'Repos' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Repos' })).toBeTruthy()

    act(() => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
  })

  it('opens /settings at Profile and corrects the address', () => {
    window.history.replaceState(null, '', '/settings')
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
    expect(window.location.pathname).toBe('/settings/profile')
    const sections = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(sections).getByRole('link', { name: 'Profile' }).getAttribute('aria-current')).toBe('page')
    expect(document.title).toBe('Profile · Settings · Pythia')
  })

  it('opens a Settings section from its address', () => {
    window.history.replaceState(null, '', '/settings/devices')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    render(<AppShell onSignOut={() => {}} />)
    const sections = screen.getByRole('navigation', { name: 'Settings' })
    expect(within(sections).getByRole('link', { name: 'Connect devices' }).getAttribute('aria-current')).toBe('page')
    expect(window.location.pathname).toBe('/settings/devices')
  })

  it('sends the old Settings storage address to Pinned', () => {
    window.history.replaceState(null, '', '/settings/storage')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    render(<AppShell onSignOut={() => {}} />)
    expect(window.location.pathname).toBe('/pinned')
    expect(screen.getByRole('heading', { level: 1, name: 'Pinned' })).toBeTruthy()
  })

  it('sends the old /import address to Sources', () => {
    window.history.replaceState(null, '', '/import')
    render(<AppShell onSignOut={() => {}} />)
    expect(window.location.pathname).toBe('/sources')
    expect(screen.getByRole('heading', { level: 1, name: 'Sources and sync' })).toBeTruthy()
    expect(nav().getByRole('link', { name: 'Sources' }).getAttribute('aria-current')).toBe('page')
  })

  it('opens a document at /doc/<id> over Search and keeps the Search tab as a link back', async () => {
    window.history.replaceState(null, '', '/doc/7')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 7,
            source: { kind: 'obsidian', name: 'vault' },
            path: 'Projects/Pythia.md',
            title: 'Pythia notes',
            language: 'markdown',
            allowLlm: true,
            mtime: null,
            updatedAt: '2026-11-21T10:00:00.000Z',
            content: 'Hello',
            truncated: false,
            totalChars: 5,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    render(<AppShell onSignOut={() => {}} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Pythia notes' })).toBeTruthy()
    const searchTab = nav().getByRole('link', { name: 'Search' })
    expect(searchTab.getAttribute('aria-current')).toBe('true')

    fireEvent.click(searchTab)
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Pythia notes' })).toBeNull()
  })

  it('opens a repo file browser at /repos/<name> and a source file browser at /sources/<kind>', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/files?source=repo&name=kitchen-app') return json(200, { documents: [], total: 0 })
        if (url === '/api/files?source=obsidian') return json(200, { documents: [], total: 0 })
        if (url === '/api/status') return json(200, statusPayload())
        return json(404, {})
      }),
    )
    window.history.replaceState(null, '', '/repos/kitchen-app')
    const { unmount } = render(<AppShell onSignOut={() => {}} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'kitchen-app' })).toBeTruthy()
    expect(nav().getByRole('link', { name: 'Repos' }).getAttribute('aria-current')).toBe('true')
    unmount()

    window.history.replaceState(null, '', '/sources/obsidian')
    render(<AppShell onSignOut={() => {}} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Obsidian vault' })).toBeTruthy()
    expect(nav().getByRole('link', { name: 'Sources' }).getAttribute('aria-current')).toBe('true')
  })

  it('signs out from Profile', () => {
    window.history.replaceState(null, '', '/settings/profile')
    const onSignOut = vi.fn()
    render(<AppShell onSignOut={onSignOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('collapses the desktop sidebar to the rail and remembers it', () => {
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(localStorage.getItem(SIDEBAR_KEY)).toBe('collapsed')
    expect(layout('desktop').className.split(' ')).toContain('hidden')
    expect(layout('desktop').className).not.toContain('lg:flex')
    expect(layout('tablet').className).not.toContain('lg:hidden')

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(localStorage.getItem(SIDEBAR_KEY)).toBeNull()
    expect(layout('desktop').className).toContain('lg:flex')
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).toBeNull()
  })

  it('opens the sidebar collapsed when this device chose so', () => {
    localStorage.setItem(SIDEBAR_KEY, 'collapsed')
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy()
  })

  it('starts a new search with Ctrl K from another screen', () => {
    window.history.replaceState(null, '', '/repos')
    render(<AppShell onSignOut={() => {}} />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  })

  it('shows an offline banner while disconnected', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.getByText(/You’re offline. Search and Ask need a connection./)).toBeTruthy()
    online.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.queryByText(/You’re offline. Search and Ask need a connection./)).toBeNull()
    online.mockRestore()
  })

  it('shows one status button naming broken checks, opens a details popover, and switches to Offline offline', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/status') return json(200, statusPayload('broken'))
      if (url === '/api/status/server') {
        return json(
          200,
          serverDetailsPayload({
            postgres: { state: 'ok', reason: null },
            ollama: { state: 'broken', reason: 'TimeoutError' },
            gemini: { state: 'ok', reason: null },
            vault: { state: 'broken', reason: 'EACCES' },
          }),
        )
      }
      return json(404, {})
    })
    vi.stubGlobal('fetch', fetch)

    render(<AppShell onSignOut={() => {}} />)

    expect(
      await within(layout('topbar')).findByRole('button', {
        name: 'Server issue: Ollama, Vault folder',
      }),
    ).toBeTruthy()
    expect(
      within(layout('mobile-top')).getByRole('button', {
        name: 'Server issue: Ollama, Vault folder',
      }),
    ).toBeTruthy()

    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.queryByRole('button', { name: /Server issue/ })).toBeNull()
    expect(within(layout('topbar')).getByRole('button', { name: 'Status: Offline' })).toBeTruthy()

    online.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    const backButton = await within(layout('topbar')).findByRole('button', {
      name: 'Server issue: Ollama, Vault folder',
    })
    expect(backButton).toBeTruthy()
    fireEvent.click(backButton)
    const panel = await within(layout('topbar')).findByRole('region', { name: 'Server issue' })
    expect(await within(panel).findByText('Gemini')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('link', { name: 'Server details' }))
    expect(window.location.pathname).toBe('/settings/server')
    expect(await screen.findByRole('heading', { level: 2, name: 'Server' })).toBeTruthy()
    online.mockRestore()
  })

  it('shows Online or Warning without fetching /api/status/server until opened', async () => {
    let currentHealth: 'ok' | 'warning' = 'ok'
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/status') return json(200, statusPayload(currentHealth))
      if (String(input) === '/api/status/server') {
        return json(200, serverDetailsPayload({ postgres: { state: 'ok', reason: null }, gemini: { state: 'ok', reason: null } }))
      }
      return json(404, {})
    })
    vi.stubGlobal('fetch', fetch)

    const { rerender } = render(<AppShell onSignOut={() => {}} />)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/status', expect.anything()))
    expect(within(layout('topbar')).getByRole('button', { name: 'Status: Online' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Server issue/ })).toBeNull()

    currentHealth = 'warning'
    act(() => {
      window.dispatchEvent(new Event('pythia:status'))
    })
    await waitFor(() =>
      expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/status').length).toBeGreaterThanOrEqual(2),
    )
    rerender(<AppShell onSignOut={() => {}} />)
    const warningButton = within(layout('topbar')).getByRole('button', { name: 'Status: Warning' })
    expect(warningButton).toBeTruthy()
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/status/server')).toBe(false)

    fireEvent.click(warningButton)
    expect(await within(layout('topbar')).findByText('PostgreSQL')).toBeTruthy()
  })
})

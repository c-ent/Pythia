import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'
import { SIDEBAR_KEY } from './nav'

// jsdom applies no CSS, so the sidebar, the rail and the phone tab bar are all
// in the tree; each test picks the layout it means.
function layout(name: 'desktop' | 'tablet' | 'mobile'): HTMLElement {
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
      'Sources',
      'Settings',
    ])
    expect(nav().getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
    expect(document.title).toBe('Search · Pythia')
  })

  it('gives the rail every screen and the phone tab bar all but Sources', () => {
    render(<AppShell onSignOut={() => {}} />)
    expect(labels(within(layout('tablet')).getByRole('navigation', { name: 'Main' }))).toEqual([
      'Search',
      'Ask',
      'Repos',
      'Pinned',
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
})

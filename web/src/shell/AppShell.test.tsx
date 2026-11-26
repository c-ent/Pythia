import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }))

describe('AppShell', () => {
  it('lists the four screens and marks the current one', () => {
    render(<AppShell onSignOut={() => {}} />)
    const links = nav().getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(['Search', 'Repos', 'Import', 'Settings'])
    expect(nav().getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
    expect(document.title).toBe('Search · Pythia')
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
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
  })

  it('opens the screen in the address bar', () => {
    window.history.replaceState(null, '', '/settings')
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy()
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
    expect(screen.getByRole('heading', { level: 1, name: 'Search' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Pythia notes' })).toBeNull()
  })

  it('signs out from the sidebar and from settings', () => {
    window.history.replaceState(null, '', '/settings')
    const onSignOut = vi.fn()
    render(<AppShell onSignOut={onSignOut} />)
    for (const button of screen.getAllByRole('button', { name: 'Sign out' })) fireEvent.click(button)
    expect(onSignOut).toHaveBeenCalledTimes(2)
  })

  it('shows an offline banner while disconnected', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<AppShell onSignOut={() => {}} />)
    expect(screen.getByRole('status').textContent).toMatch(/offline/i)
    online.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(screen.queryByRole('status')).toBeNull()
    online.mockRestore()
  })
})

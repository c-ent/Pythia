import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from './AppShell'
import { SIDEBAR_RECENT_SHOWN } from './RecentQueries'

// Recent searches and questions (T35, R14): the desktop sidebar list and the
// phone Home card, both backed by `/api/recent-queries`.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Entry {
  id: number
  kind: 'search' | 'ask'
  query: string
  filters: { sources?: string[] }
  at: string
}

const entry = (id: number, kind: Entry['kind'], query: string, filters: Entry['filters'] = {}): Entry => ({
  id,
  kind,
  query,
  filters,
  at: new Date().toISOString(),
})

const ASK_RESPONSE = {
  answer: 'An answer.',
  engine: 'gemini',
  model: 'gemini',
  fallbacks: [],
  citations: [],
  withheld: 0,
  degraded: false,
}

/** A fake server that keeps the lists, records searches and questions, and serves removes and clears. */
function stubServer(initial: Entry[] = [], { failDelete = false }: { failDelete?: boolean } = {}) {
  let rows = [...initial]
  let nextId = 100
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>)
    calls.push({ method, url, ...(body === undefined ? {} : { body }) })
    const record = (kind: Entry['kind'], query: string, sources: unknown): void => {
      rows = rows.filter((row) => !(row.kind === kind && row.query === query))
      rows.unshift(entry(nextId++, kind, query, Array.isArray(sources) ? { sources: sources as string[] } : {}))
    }
    if (url === '/api/search' && method === 'POST') {
      record('search', String(body?.query), body?.sources)
      return json(200, { results: [], degraded: false })
    }
    if (url === '/api/ask' && method === 'POST') {
      record('ask', String(body?.question), body?.sources)
      return json(200, ASK_RESPONSE)
    }
    if (url.startsWith('/api/recent-queries')) {
      const parsed = new URL(url, 'http://localhost')
      const idMatch = /^\/api\/recent-queries\/(\d+)$/.exec(parsed.pathname)
      if (method === 'DELETE') {
        if (failDelete) return json(500, { error: { code: 'internal', message: 'boom' } })
        if (idMatch !== null) {
          const id = Number(idMatch[1])
          if (!rows.some((row) => row.id === id)) return json(404, { error: { code: 'not_found', message: 'gone' } })
          rows = rows.filter((row) => row.id !== id)
        } else {
          const kind = parsed.searchParams.get('kind')
          rows = rows.filter((row) => row.kind !== kind)
        }
        return new Response(null, { status: 204 })
      }
      const kind = parsed.searchParams.get('kind')
      const limit = Number(parsed.searchParams.get('limit') ?? 20)
      return json(200, { queries: rows.filter((row) => row.kind === kind).slice(0, limit) })
    }
    if (url.startsWith('/api/recent?')) return json(200, { documents: [] })
    return json(404, { error: { code: 'not_found', message: 'nope' } })
  })
  vi.stubGlobal('fetch', fn)
  return { calls, rows: () => rows }
}

function sidebar(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-layout="desktop"]')
  if (element === null) throw new Error('No sidebar')
  return element
}

const sidebarList = (name: string) => within(sidebar()).findByRole('region', { name })

describe('Recent queries', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists recent searches in the sidebar, newest first', async () => {
    stubServer([entry(2, 'search', 'goals'), entry(1, 'search', 'docker setup')])
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    await waitFor(() =>
      expect(within(list).getAllByRole('button', { name: /^(goals|docker setup)$/ }).map((b) => b.textContent)).toEqual([
        'goals',
        'docker setup',
      ]),
    )
  })

  it('caps the sidebar list at 2 entries without making it scrollable', async () => {
    expect(SIDEBAR_RECENT_SHOWN).toBe(2)
    const { calls } = stubServer(Array.from({ length: 5 }, (_, i) => entry(i + 1, 'search', `query ${i + 1}`)))
    render(<AppShell onSignOut={() => {}} />)
    const region = await sidebarList('Recent searches')
    await within(region).findByRole('button', { name: 'query 1' })
    const list = within(region).getByTestId('recent-list')
    expect(list.className).not.toMatch(/\boverflow-y-auto\b/)
    expect(region.className).not.toMatch(/\bflex-1\b/)
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByRole('button', { name: 'query 1' })).toBeTruthy()
    expect(within(list).getByRole('button', { name: 'query 2' })).toBeTruthy()
    expect(within(list).queryByRole('button', { name: 'query 3' })).toBeNull()
    expect(calls).toContainEqual({ method: 'GET', url: '/api/recent-queries?kind=search&limit=2' })
  })

  it('says so when there are none yet', async () => {
    stubServer()
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    expect(await within(list).findByText('Searches you run show up here.')).toBeTruthy()
    expect(within(list).queryByRole('button', { name: 'Clear recent searches' })).toBeNull()
  })

  it('runs a recent search again with its source filter, from another page', async () => {
    const { calls } = stubServer([entry(1, 'search', 'goals', { sources: ['repo'] })])
    window.history.replaceState(null, '', '/repos')
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    fireEvent.click(await within(list).findByRole('button', { name: 'goals' }))
    expect(window.location.pathname).toBe('/')
    expect(await screen.findByText('No matches for “goals”')).toBeTruthy()
    expect(calls).toContainEqual({ method: 'POST', url: '/api/search', body: { query: 'goals', limit: 20, sources: ['repo'] } })
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'goals')
  })

  it('shows the latest 1 or 2 searches and pushes older ones out when searching again', async () => {
    stubServer([entry(1, 'search', 'oldest')])
    render(<AppShell onSignOut={() => {}} />)
    const region = await sidebarList('Recent searches')
    await within(region).findByRole('button', { name: 'oldest' })
    expect(within(within(region).getByTestId('recent-list')).getAllByRole('listitem')).toHaveLength(1)

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'second' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(within(region).getAllByRole('button', { name: /^(second|oldest)$/ }).map((b) => b.textContent)).toEqual([
        'second',
        'oldest',
      ]),
    )

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'latest' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(within(region).getAllByRole('button', { name: /^(latest|second)$/ }).map((b) => b.textContent)).toEqual([
        'latest',
        'second',
      ]),
    )
    expect(within(region).queryByRole('button', { name: 'oldest' })).toBeNull()
  })

  it('shows recent questions on the Ask page and asks one again', async () => {
    const { calls } = stubServer([entry(1, 'search', 'goals'), entry(2, 'ask', 'Which repo uses Docker?')])
    window.history.replaceState(null, '', '/ask')
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent questions')
    expect(within(sidebar()).queryByRole('region', { name: 'Recent searches' })).toBeNull()
    fireEvent.click(await within(list).findByRole('button', { name: 'Which repo uses Docker?' }))
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', url: '/api/ask', body: { question: 'Which repo uses Docker?' } }),
    )
    expect(await screen.findByRole('heading', { level: 1, name: 'Which repo uses Docker?' })).toBeTruthy()
  })

  it('removes one entry', async () => {
    const { calls, rows } = stubServer([entry(2, 'search', 'goals'), entry(1, 'search', 'docker setup')])
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    fireEvent.click(await within(list).findByRole('button', { name: 'Remove “goals”' }))
    await waitFor(() => expect(within(list).queryByRole('button', { name: 'goals' })).toBeNull())
    expect(within(list).getByRole('button', { name: 'docker setup' })).toBeTruthy()
    expect(calls).toContainEqual({ method: 'DELETE', url: '/api/recent-queries/2' })
    expect(rows().map((row) => row.query)).toEqual(['docker setup'])
  })

  it('clears the list', async () => {
    const { calls, rows } = stubServer([entry(2, 'search', 'goals'), entry(3, 'ask', 'kept?')])
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    await within(list).findByRole('button', { name: 'goals' })
    fireEvent.click(within(list).getByRole('button', { name: 'Clear recent searches' }))
    expect(await within(list).findByText('Searches you run show up here.')).toBeTruthy()
    expect(calls).toContainEqual({ method: 'DELETE', url: '/api/recent-queries?kind=search' })
    expect(rows().map((row) => row.query)).toEqual(['kept?'])
  })

  it('puts the entry back and says so when removing fails', async () => {
    stubServer([entry(2, 'search', 'goals')], { failDelete: true })
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    fireEvent.click(await within(list).findByRole('button', { name: 'Remove “goals”' }))
    expect(await within(list).findByRole('alert')).toHaveProperty('textContent', 'Couldn’t remove it. Try again.')
    expect(await within(list).findByRole('button', { name: 'goals' })).toBeTruthy()
  })

  it('keeps the phone Home card and the sidebar in step', async () => {
    stubServer([entry(2, 'search', 'goals'), entry(1, 'search', 'docker setup')])
    render(<AppShell onSignOut={() => {}} />)
    // jsdom applies no CSS, so the phone-only Home card is in the tree beside the sidebar list.
    await waitFor(() => expect(screen.getAllByRole('region', { name: 'Recent searches' })).toHaveLength(2))
    const card = screen.getAllByRole('region', { name: 'Recent searches' }).find((region) => !sidebar().contains(region))
    if (card === undefined) throw new Error('No Home card')
    const list = await sidebarList('Recent searches')
    await within(list).findByRole('button', { name: 'goals' })
    fireEvent.click(within(card).getByRole('button', { name: 'Remove “goals”' }))
    await waitFor(() => expect(within(list).queryByRole('button', { name: 'goals' })).toBeNull())
    expect(within(card).queryByRole('button', { name: 'goals' })).toBeNull()
  })

  it('loads nothing while offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { calls } = stubServer([entry(1, 'search', 'goals')])
    render(<AppShell onSignOut={() => {}} />)
    const list = await sidebarList('Recent searches')
    expect(within(list).getByText('Needs a connection.')).toBeTruthy()
    expect(calls.filter((call) => call.url.startsWith('/api/recent-queries'))).toEqual([])
    online.mockRestore()
  })
})

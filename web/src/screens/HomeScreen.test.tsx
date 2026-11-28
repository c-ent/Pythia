import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from '../api/profile'
import { PROFILE_KEY } from '../profile/profile'
import { PINS_KEY } from '../repos/pins'
import { TRY_ASKING_EXAMPLES } from './home'
import { SearchScreen } from './SearchScreen'

// Home is what Search shows before anything is searched (T31).

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const doc = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  source: { kind: 'obsidian', name: 'vault' },
  path: `Notes/Doc ${id}.md`,
  title: `Doc ${id}`,
  language: 'markdown',
  allowLlm: true,
  mtime: null,
  updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  ...over,
})

const question = (id: number, query: string) => ({ id, kind: 'ask', query, filters: {}, at: new Date().toISOString() })

interface Data {
  documents?: unknown[]
  questions?: unknown[]
  searches?: unknown[]
  failRecent?: boolean
}

function stubServer(data: Data = {}) {
  const urls: string[] = []
  const posts: { url: string; body: Record<string, unknown> }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    urls.push(url)
    if (init.body !== undefined) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      if (url === '/api/ask') {
        return json(200, {
          answer: 'An answer.',
          engine: 'gemini',
          model: 'gemini',
          fallbacks: [],
          citations: [],
          withheld: 0,
          degraded: false,
        })
      }
      return json(200, { results: [], degraded: false })
    }
    if (url.startsWith('/api/recent?')) {
      if (data.failRecent === true) return json(500, { error: { code: 'internal', message: 'boom' } })
      return json(200, { documents: data.documents ?? [] })
    }
    if (url.startsWith('/api/recent-queries?kind=ask')) return json(200, { queries: data.questions ?? [] })
    if (url.startsWith('/api/recent-queries?kind=search')) return json(200, { queries: data.searches ?? [] })
    return json(404, { error: { code: 'not_found', message: 'Not found' } })
  })
  vi.stubGlobal('fetch', fn)
  return { urls, posts }
}

const card = (name: string) => screen.getByRole('region', { name })

describe('Home', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('greets the owner by the name in Profile', () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...DEFAULT_PROFILE, displayName: 'Cent' }))
    stubServer()
    render(<SearchScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Hi, Cent' })).toBeTruthy()
    expect(screen.getByText('What are you looking for?')).toBeTruthy()
  })

  it('greets without a name until one is set', () => {
    stubServer()
    render(<SearchScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Hi there' })).toBeTruthy()
  })

  it('switches between Search and Ask, with the Gemini note only in Ask', () => {
    stubServer()
    render(<SearchScreen />)
    expect(screen.getByRole('radio', { name: 'Search' })).toHaveProperty('checked', true)
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.queryByText(/Answers come from Gemini/)).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: 'Ask' }))
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy()
    expect(screen.getByText(/Answers come from Gemini/)).toBeTruthy()
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toMatch(/Ask a question/)
  })

  it('shows the source chips All, Notes, Repos, Keep and Drive', () => {
    stubServer()
    render(<SearchScreen />)
    const chips = within(screen.getByRole('group', { name: 'Sources' })).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['All', 'Notes', 'Repos', 'Keep', 'Drive'])
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chips[1]!)
    expect(chips[1]?.getAttribute('aria-pressed')).toBe('true')
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows an empty state in every card when nothing is indexed, never sample data', async () => {
    stubServer()
    render(<SearchScreen />)
    expect(await within(card('Recent changes')).findByText('Nothing changed in the last 30 days.')).toBeTruthy()
    expect(within(card('Pinned offline')).getByText(/No repos pinned yet/)).toBeTruthy()
    expect(within(card('Pinned offline')).getByRole('link', { name: 'Pin a repo' }).getAttribute('href')).toBe('/repos')
    const tryAsking = card('Try asking')
    await waitFor(() =>
      expect(within(tryAsking).getAllByRole('button').map((b) => b.textContent)).toEqual([...TRY_ASKING_EXAMPLES]),
    )
    // No recent searches: the phone-only card stays away.
    expect(screen.queryByRole('region', { name: 'Recent searches' })).toBeNull()
  })

  it('lists recent changes that open their document', async () => {
    const { urls } = stubServer({ documents: [doc(7), doc(8, { source: { kind: 'repo', name: 'kitchen-app' }, title: 'auth.ts' })] })
    render(<SearchScreen />)
    const recent = card('Recent changes')
    const link = await within(recent).findByRole('link', { name: /Doc 7/ })
    expect(link.getAttribute('href')).toBe('/doc/7')
    expect(link.textContent).toContain('Note · 2h ago')
    expect(within(recent).getByRole('link', { name: /auth\.ts/ }).textContent).toContain('kitchen-app · 2h ago')
    expect(urls).toContain('/api/recent?days=30&limit=3')
  })

  it('says when recent changes could not load', async () => {
    stubServer({ failRecent: true })
    render(<SearchScreen />)
    expect((await within(card('Recent changes')).findByRole('alert')).textContent).toMatch(/Couldn’t load/)
  })

  it('lists the pinned repos and links to Pinned', () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(['kitchen-app', 'pythia']))
    stubServer()
    render(<SearchScreen />)
    const pinned = card('Pinned offline')
    expect(within(pinned).getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/pinned')
    expect(within(pinned).getByRole('link', { name: /kitchen-app/ }).textContent).toContain('Repo')
    expect(within(pinned).getByRole('link', { name: /pythia/ })).toBeTruthy()
  })

  it('shows the last three questions in Try asking and asks one when clicked', async () => {
    const { urls, posts } = stubServer({
      questions: [question(3, 'third?'), question(2, 'second?'), question(1, 'first?')],
    })
    render(<SearchScreen />)
    const tryAsking = card('Try asking')
    await waitFor(() =>
      expect(within(tryAsking).getAllByRole('button').map((b) => b.textContent)).toEqual(['third?', 'second?', 'first?']),
    )
    expect(urls).toContain('/api/recent-queries?kind=ask&limit=3')

    fireEvent.click(within(tryAsking).getByRole('button', { name: 'second?' }))
    expect(await screen.findByRole('region', { name: 'Answer' })).toBeTruthy()
    expect(posts).toContainEqual({ url: '/api/ask', body: { question: 'second?' } })
    expect(screen.queryByRole('heading', { level: 1, name: 'Hi there' })).toBeNull()
    expect(screen.getByRole('searchbox')).toHaveProperty('value', 'second?')
  })

  it('runs a recent search again from the phone card', async () => {
    const { posts } = stubServer({ searches: [{ id: 1, kind: 'search', query: 'goals', filters: {}, at: '' }] })
    render(<SearchScreen />)
    const recent = await screen.findByRole('region', { name: 'Recent searches' })
    fireEvent.click(within(recent).getByRole('button', { name: 'goals' }))
    expect(await screen.findByText('No matches for “goals”')).toBeTruthy()
    expect(posts).toEqual([{ url: '/api/search', body: { query: 'goals', limit: 20 } }])
  })

  it('needs no server while offline: examples in Try asking, a note in Recent changes', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { urls } = stubServer()
    render(<SearchScreen />)
    expect(within(card('Recent changes')).getByText('Recent changes need a connection.')).toBeTruthy()
    expect(within(card('Try asking')).getAllByRole('button')).toHaveLength(TRY_ASKING_EXAMPLES.length)
    expect(urls).toEqual([])
    online.mockRestore()
  })
})

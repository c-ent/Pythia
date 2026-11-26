import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AskCitation, AskResponse } from '../api/ask'
import type { SearchResponse, SearchResult } from '../api/search'
import { SearchScreen } from './SearchScreen'

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  chunkId: 1,
  documentId: 7,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Projects/Pythia.md',
  title: 'Pythia',
  headingPath: 'Pythia > Goals',
  startLine: 1,
  endLine: 5,
  allowLlm: true,
  score: 0.03,
  ftsRank: 1,
  vectorRank: 2,
  snippet: { text: 'Private knowledge server goals', highlights: [[8, 17]] },
  ...over,
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubSearch(respond: (body: Record<string, unknown>) => Response = () => json(200, { results: [result()], degraded: false })) {
  const bodies: Record<string, unknown>[] = []
  const fn = vi.fn(async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    bodies.push(body)
    return respond(body)
  })
  vi.stubGlobal('fetch', fn)
  return { bodies, fn }
}

const respondWith = (response: SearchResponse) => () => json(200, response)

/** The `[n]` citation markers in an answer (source titles are links too). */
const markerLinks = (answer: HTMLElement) =>
  within(answer)
    .queryAllByRole('link')
    .filter((link) => /^source \d+$/.test(link.textContent ?? ''))

function search(text: string, button = 'Search') {
  fireEvent.change(screen.getByLabelText('Search notes, repos and Keep'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: button }))
}

describe('SearchScreen', () => {
  it('searches and shows ranked cards with highlights, heading path and source', async () => {
    const { bodies } = stubSearch()
    const { container } = render(<SearchScreen />)
    search('  goals ')
    expect(await screen.findByText('1 result')).toBeTruthy()
    expect(bodies).toEqual([{ query: 'goals', limit: 20 }])
    expect(container.querySelector('mark')?.textContent).toBe('knowledge')
    const card = screen.getByRole('article')
    expect(within(card).getByRole('heading', { name: 'Pythia' })).toBeTruthy()
    expect(within(card).getByText('Goals')).toBeTruthy()
    expect(within(card).getByText('Obsidian')).toBeTruthy()
    expect(within(card).getByText('Projects/Pythia.md')).toBeTruthy()
    expect(within(card).queryByText('Local only')).toBeNull()
  })

  it('keeps the submit button disabled for an empty query', () => {
    stubSearch()
    render(<SearchScreen />)
    expect(screen.getByRole('button', { name: 'Search' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Search notes, repos and Keep'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Search' })).toHaveProperty('disabled', true)
  })

  it('re-runs the search when source chips change', async () => {
    const { bodies } = stubSearch()
    render(<SearchScreen />)
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')
    search('goals')
    await screen.findByText('1 result')

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual({ query: 'goals', limit: 20, sources: ['keep'] })
    expect(screen.getByRole('button', { name: 'Keep' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: 'Obsidian' }))
    await waitFor(() => expect(bodies).toHaveLength(3))
    expect(bodies[2]).toMatchObject({ sources: ['obsidian', 'keep'] })

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(bodies).toHaveLength(4))
    expect(bodies[3]).toEqual({ query: 'goals', limit: 20 })
  })

  it('does not search when a chip changes before any search', () => {
    const { fn } = stubSearch()
    render(<SearchScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'Repos' }))
    expect(fn).not.toHaveBeenCalled()
  })

  it('shows an empty state', async () => {
    stubSearch(respondWith({ results: [], degraded: false }))
    render(<SearchScreen />)
    search('zzz')
    expect(await screen.findByText('No matches for “zzz”')).toBeTruthy()
  })

  it('says when only full-text search ran', async () => {
    stubSearch(respondWith({ results: [result()], degraded: true }))
    render(<SearchScreen />)
    search('goals')
    expect(await screen.findByText(/word matches only/)).toBeTruthy()
  })

  it('marks results that never go to Gemini and labels repos by name', async () => {
    stubSearch(
      respondWith({
        results: [result({ allowLlm: false, source: { kind: 'repo', name: 'kitchen-app' }, path: 'README.md' })],
        degraded: false,
      }),
    )
    render(<SearchScreen />)
    search('goals')
    const card = await screen.findByRole('article')
    expect(within(card).getByText('Local only')).toBeTruthy()
    expect(within(card).getByText('kitchen-app')).toBeTruthy()
  })

  it('shows a clear error when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    render(<SearchScreen />)
    search('goals')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Can’t reach the server/)
  })

  it('does not call the server while offline', async () => {
    const { fn } = stubSearch()
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SearchScreen />)
    search('goals')
    expect((await screen.findByRole('alert')).textContent).toMatch(/offline/)
    expect(fn).not.toHaveBeenCalled()
    online.mockRestore()
  })

  describe('Ask mode', () => {
    const citation = (n: number, over: Partial<AskCitation> = {}): AskCitation => ({
      n,
      chunkId: n,
      documentId: 7,
      source: { kind: 'obsidian', name: 'vault' },
      path: `Notes/Note ${n}.md`,
      title: `Note ${n}`,
      headingPath: `Note ${n}`,
      startLine: null,
      endLine: null,
      allowLlm: true,
      snippet: { text: `passage ${n}`, highlights: [] },
      ...over,
    })

    const askResponse = (over: Partial<AskResponse> = {}): AskResponse => ({
      answer: 'The goal is one index [1], kept private [2].',
      engine: 'gemini',
      model: 'gemini-3.5-flash-lite',
      fallbacks: [],
      citations: [citation(1), citation(2)],
      withheld: 0,
      degraded: false,
      ...over,
    })

    /** Routes `/api/ask` and `/api/search` to separate stubs and records both bodies. */
    function stubAsk(ask: () => Response | Promise<Response>) {
      const askBodies: Record<string, unknown>[] = []
      const searchBodies: Record<string, unknown>[] = []
      const results = [1, 2, 3, 4, 5].map((n) => result({ chunkId: n, title: `Match ${n}`, headingPath: `Match ${n}` }))
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (url === '/api/ask') {
          askBodies.push(body)
          return ask()
        }
        searchBodies.push(body)
        return json(200, { results, degraded: false })
      })
      return { askBodies, searchBodies }
    }

    function ask(text: string) {
      fireEvent.click(screen.getByRole('radio', { name: 'Ask' }))
      search(text, 'Ask')
    }

    it('shows the generated answer with linked citations, the engine badge and all matches', async () => {
      const { askBodies, searchBodies } = stubAsk(() => json(200, askResponse()))
      render(<SearchScreen />)
      ask('  what are the goals? ')

      const answer = await screen.findByRole('region', { name: 'Answer' })
      await within(answer).findByText('Gemini')
      expect(askBodies).toEqual([{ question: 'what are the goals?' }])
      expect(searchBodies).toEqual([{ query: 'what are the goals?', limit: 20 }])
      expect(answer.textContent).toContain('The goal is one index')

      const links = markerLinks(answer)
      expect(links.map((link) => link.textContent)).toEqual(['source 1', 'source 2'])
      // Each source title opens its document.
      expect(within(answer).getByRole('link', { name: 'Note 1' }).getAttribute('href')).toMatch(/^\/doc\/\d+$/)
      const target = document.getElementById(links[0]!.getAttribute('href')!.slice(1))
      expect(target?.textContent).toContain('Note 1')
      fireEvent.click(links[0]!)
      expect(document.activeElement).toBe(target)

      expect(within(answer).getByText('Sources')).toBeTruthy()
      expect(within(answer).getByText('Notes/Note 2.md')).toBeTruthy()
      // With a generated answer the passages are not repeated as snippets.
      expect(within(answer).queryByText('passage 1')).toBeNull()
      expect(await screen.findByText('All matches · 5 results')).toBeTruthy()
    })

    it('sends the source filter with the question', async () => {
      const { askBodies } = stubAsk(() => json(200, askResponse()))
      render(<SearchScreen />)
      fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
      ask('shopping list')
      await screen.findByText('Gemini')
      expect(askBodies).toEqual([{ question: 'shopping list', sources: ['keep'] }])
    })

    it('keeps unknown [n] markers as plain text', async () => {
      stubAsk(() => json(200, askResponse({ answer: 'See [1] and [9].', citations: [citation(1)] })))
      render(<SearchScreen />)
      ask('goals')
      const answer = await screen.findByRole('region', { name: 'Answer' })
      await within(answer).findByText('Gemini')
      expect(markerLinks(answer)).toHaveLength(1)
      expect(answer.textContent).toContain('and [9].')
    })

    it('labels a local-model fallback and why it happened', async () => {
      stubAsk(() =>
        json(200, askResponse({ engine: 'ollama', model: 'qwen3:4b', fallbacks: ['gemini_unconfigured'] })),
      )
      render(<SearchScreen />)
      ask('goals')
      const answer = await screen.findByRole('region', { name: 'Answer' })
      expect(await within(answer).findByText('Local model')).toBeTruthy()
      expect(within(answer).getByText(/Gemini isn’t set up/)).toBeTruthy()
    })

    it('says how many local-only matches were kept from Gemini', async () => {
      stubAsk(() => json(200, askResponse({ withheld: 2 })))
      render(<SearchScreen />)
      ask('goals')
      expect(await screen.findByText('2 local-only matches were kept from Gemini.')).toBeTruthy()
    })

    it('shows retrieval-only passages as the answer when no model answers', async () => {
      stubAsk(() =>
        json(
          200,
          askResponse({
            answer: null,
            engine: 'retrieval',
            model: null,
            fallbacks: ['gemini_unconfigured', 'ollama_unconfigured'],
            citations: [citation(1), citation(2, { allowLlm: false }), citation(3)],
          }),
        ),
      )
      render(<SearchScreen />)
      ask('goals')
      const answer = await screen.findByRole('region', { name: 'Answer' })
      expect(await within(answer).findByText('Retrieval only')).toBeTruthy()
      expect(within(answer).getByText(/No AI model is set up/)).toBeTruthy()
      expect(within(answer).getAllByRole('listitem')).toHaveLength(3)
      expect(within(answer).getByText('passage 3')).toBeTruthy()
      expect(within(answer).getByText('Local only')).toBeTruthy()
      // No answer text, so no [n] markers; only the source titles link to their documents.
      expect(markerLinks(answer)).toHaveLength(0)
      expect(within(answer).getAllByRole('link').map((link) => link.getAttribute('href'))).toHaveLength(3)
    })

    it('shows an answer error but keeps the matches', async () => {
      stubAsk(() => json(500, { error: { code: 'internal', message: 'Internal server error' } }))
      render(<SearchScreen />)
      ask('goals')
      const answer = await screen.findByRole('region', { name: 'Answer' })
      expect((await within(answer).findByRole('alert')).textContent).toMatch(/answer failed/)
      expect(await screen.findByText('All matches · 5 results')).toBeTruthy()
    })

    it('drops the answer when switching back to Search', async () => {
      stubAsk(() => json(200, askResponse()))
      render(<SearchScreen />)
      ask('goals')
      await screen.findByText('Gemini')
      fireEvent.click(screen.getByRole('radio', { name: 'Search' }))
      expect(screen.queryByRole('region', { name: 'Answer' })).toBeNull()
      expect(screen.getByText('5 results')).toBeTruthy()
    })

    it('ignores a late answer to an older question', async () => {
      let release: (() => void) | undefined
      let calls = 0
      stubAsk(async () => {
        calls += 1
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return json(200, askResponse({ answer: 'stale answer' }))
        }
        return json(200, askResponse({ answer: 'fresh answer' }))
      })
      render(<SearchScreen />)
      ask('first')
      search('second', 'Ask')
      const answer = await screen.findByRole('region', { name: 'Answer' })
      await within(answer).findByText('fresh answer')
      release?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByText('stale answer')).toBeNull()
    })
  })

  it('shows only the newest search when an older one finishes late', async () => {
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as { query: string }
      if (body.query === 'slow') {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
        return json(200, { results: [result({ title: 'Slow' })], degraded: false })
      }
      return json(200, { results: [result({ title: 'Fast' })], degraded: false })
    })
    render(<SearchScreen />)
    search('slow')
    search('fast')
    expect(await screen.findByRole('heading', { name: 'Fast' })).toBeTruthy()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('heading', { name: 'Slow' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('focuses the search box on "/"', () => {
    stubSearch()
    render(<SearchScreen />)
    fireEvent.keyDown(window, { key: '/' })
    expect(document.activeElement).toBe(screen.getByLabelText('Search notes, repos and Keep'))
  })
})

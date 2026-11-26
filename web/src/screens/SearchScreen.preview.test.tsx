import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DocumentView } from '../api/documents'
import { DEFAULT_PROFILE } from '../api/profile'
import type { SearchResult } from '../api/search'
import { PROFILE_KEY } from '../profile/profile'
import { documentPath } from '../router'
import { PreviewPane } from '../search/PreviewPane'
import { PREVIEW_PANE_QUERY, SearchScreen } from './SearchScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

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

const RESULTS = [
  result(),
  result({
    chunkId: 2,
    documentId: 9,
    source: { kind: 'repo', name: 'pythia' },
    path: 'server/src/app.ts',
    title: 'app.ts',
    headingPath: '',
    snippet: { text: 'const app = createApp()', highlights: [] },
  }),
]

const doc = (id: number, title: string, content: string, over: Partial<DocumentView> = {}): DocumentView => ({
  id,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Projects/Pythia.md',
  title,
  language: 'markdown',
  allowLlm: true,
  mtime: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-21T10:00:00.000Z',
  content,
  truncated: false,
  totalChars: content.length,
  ...over,
})

const DOCS: Record<string, DocumentView> = {
  '/api/documents/7': doc(7, 'Pythia', 'Body of the Pythia note.'),
  '/api/documents/9': doc(9, 'app.ts', 'export const marker = "app file body"', {
    source: { kind: 'repo', name: 'pythia' },
    path: 'server/src/app.ts',
    language: 'typescript',
  }),
}

function stubFetch() {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      urls.push(url)
      if (init.body !== undefined) return json(200, { results: RESULTS, degraded: false })
      const found = DOCS[url]
      if (found !== undefined) return json(200, found)
      if (url.startsWith('/api/documents/')) return json(404, { error: 'not_found' })
      // Home's cards.
      return json(200, { documents: [], queries: [] })
    }),
  )
  return urls
}

/** `matchMedia` where only the preview-pane width matches (or nothing does). */
function stubWidth(wide: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query === PREVIEW_PANE_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

function search(text: string): void {
  fireEvent.change(screen.getByLabelText('Search notes, repos and Keep'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
}

describe('Search preview pane', () => {
  beforeAll(async () => {
    // The renderer is a lazy chunk; warm it so `findBy` does not time out.
    await import('../document/DocumentBody')
  })

  afterEach(() => {
    localStorage.removeItem(PROFILE_KEY)
  })

  it('previews the first result on wide screens and switches on click', async () => {
    stubWidth(true)
    const urls = stubFetch()
    render(<SearchScreen />)
    search('goals')

    const pane = await screen.findByRole('complementary', { name: 'Preview' })
    expect(within(pane).getByRole('heading', { level: 2, name: 'Pythia' })).toBeTruthy()
    expect(await within(pane).findByText('Body of the Pythia note.')).toBeTruthy()
    expect(urls).toContain('/api/documents/7')

    const first = screen.getAllByRole('article')[0]!
    expect(within(first).getByRole('link', { name: 'Pythia' }).getAttribute('aria-current')).toBe('true')

    const second = screen.getAllByRole('article')[1]!
    fireEvent.click(within(second).getByRole('link', { name: 'app.ts' }))

    // The pane remounts for the new document, so look it up again.
    const preview = () => screen.getByRole('complementary', { name: 'Preview' })
    await waitFor(() => expect(within(preview()).getByRole('heading', { level: 2, name: 'app.ts' })).toBeTruthy())
    expect(await within(preview()).findByText(/app file body/)).toBeTruthy()
    expect(urls).toContain('/api/documents/9')
    expect(within(second).getByRole('link', { name: 'app.ts' }).getAttribute('aria-current')).toBe('true')
    expect(within(first).getByRole('link', { name: 'Pythia' }).getAttribute('aria-current')).toBeNull()
    // Selecting stays on the search page.
    expect(window.location.pathname).toBe('/')
  })

  it('keeps plain links without a pane on narrow screens', async () => {
    stubWidth(false)
    stubFetch()
    render(<SearchScreen />)
    search('goals')

    expect(await screen.findByText('2 results')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Preview' })).toBeNull()
    const link = within(screen.getAllByRole('article')[0]!).getByRole('link', { name: 'Pythia' })
    expect(link.getAttribute('aria-current')).toBeNull()
    fireEvent.click(link)
    expect(window.location.pathname).toBe(documentPath(7))
  })

  it('shows result counts on the source chips when unfiltered', async () => {
    stubWidth(false)
    stubFetch()
    render(<SearchScreen />)
    search('goals')
    await screen.findByText('2 results')

    const chips = screen.getByRole('group', { name: 'Sources' })
    // The counts are visual only; the chips keep their plain names.
    expect(within(chips).getByRole('button', { name: 'All' }).textContent).toBe('All2')
    expect(within(chips).getByRole('button', { name: 'Notes' }).textContent).toBe('Notes1')
    expect(within(chips).getByRole('button', { name: 'Keep' }).textContent).toBe('Keep0')
    // With a filter on, the other sources would all read 0, so counts go.
    fireEvent.click(within(chips).getByRole('button', { name: 'Notes' }))
    await waitFor(() => expect(within(chips).getByRole('button', { name: 'All' }).textContent).toBe('All'))
  })
})

describe('PreviewPane', () => {
  beforeAll(async () => {
    await import('../document/DocumentBody')
  })

  afterEach(() => {
    localStorage.removeItem(PROFILE_KEY)
  })

  it('links to the full page and offers Open in Obsidian when a vault is named', async () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...DEFAULT_PROFILE, vaultName: 'My Notes' }))
    stubFetch()
    render(<PreviewPane result={result()} />)

    expect(screen.getByText('Loading preview…')).toBeTruthy()
    expect(await screen.findByText('Body of the Pythia note.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open page' }).getAttribute('href')).toBe(documentPath(7))
    expect(screen.getByRole('link', { name: /Open in Obsidian/ }).getAttribute('href')).toBe(
      'obsidian://open?vault=My%20Notes&file=Projects%2FPythia.md',
    )
    expect(screen.getByRole('button', { name: 'Copy file path' })).toBeTruthy()
  })

  it('has no Obsidian link without a vault name or for repo files', async () => {
    stubFetch()
    render(<PreviewPane result={RESULTS[1]!} />)
    expect(await screen.findByText(/app file body/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Open in Obsidian/ })).toBeNull()
  })

  it('shows an error when the document cannot be opened', async () => {
    stubFetch()
    render(<PreviewPane result={result({ documentId: 404 })} />)
    expect((await screen.findByRole('alert')).textContent).not.toBe('')
  })
})

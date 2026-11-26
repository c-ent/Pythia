import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentView } from '../api/documents'
import { offlineDb } from '../offline/db'
import { DocumentScreen } from './DocumentScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const note = (over: Partial<DocumentView> = {}): DocumentView => ({
  id: 7,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Projects/Pythia.md',
  title: 'Pythia',
  language: 'markdown',
  allowLlm: true,
  mtime: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-21T10:00:00.000Z',
  content: [
    '# Goals',
    '',
    'A **private** knowledge server.',
    '',
    '- [x] Search',
    '- [ ] Offline',
    '',
    '| Source | Kind |',
    '| --- | --- |',
    '| vault | obsidian |',
    '',
    '```ts',
    'const answer = 42',
    '```',
  ].join('\n'),
  truncated: false,
  totalChars: 120,
  ...over,
})

function stubFetch(respond: (url: string) => Response | Promise<Response>) {
  const urls: string[] = []
  const fn = vi.fn(async (url: string) => {
    urls.push(url)
    return respond(url)
  })
  vi.stubGlobal('fetch', fn)
  return { urls, fn }
}

describe('DocumentScreen', () => {
  beforeAll(async () => {
    // The renderer is a lazy chunk; loading it cold in jsdom takes longer than
    // `findBy`'s default wait, so warm it once before the tests.
    await import('../document/DocumentBody')
  })

  beforeEach(async () => {
    await offlineDb().documents.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the document by id and renders the header and Markdown', async () => {
    const { urls } = stubFetch(() => json(200, note()))
    render(<DocumentScreen id={7} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Pythia' })).toBeTruthy()
    expect(urls).toEqual(['/api/documents/7'])
    expect(screen.getByText('Projects/Pythia.md')).toBeTruthy()
    expect(screen.getByText('Obsidian')).toBeTruthy()
    expect(document.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-20T10:00:00.000Z')
    // Set in an effect after the render that shows the heading, so wait for it.
    await waitFor(() => expect(document.title).toBe('Pythia · Pythia'))

    // The note's own `#` heading moves below the page title.
    // The renderer loads lazily, so the body appears after the header.
    expect(await screen.findByRole('heading', { level: 2, name: 'Goals' })).toBeTruthy()
    expect(screen.getByText('private').tagName).toBe('STRONG')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(within(screen.getByRole('table')).getByText('obsidian')).toBeTruthy()

    const code = document.querySelector('pre code')
    expect(code?.className).toContain('hljs')
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const')
    expect(screen.queryByText(/Local only/)).toBeNull()
  })

  it('shows a repo code file as one highlighted code block', async () => {
    const source = 'export function login(user: string) {\n  return `hi ${user}` // ``` inside\n}\n'
    stubFetch(() =>
      json(200, note({ source: { kind: 'repo', name: 'kitchen-app' }, path: 'src/auth.ts', title: 'auth.ts', language: 'typescript', content: source })),
    )
    render(<DocumentScreen id={7} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'auth.ts' })).toBeTruthy()
    expect(screen.getByText('kitchen-app')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('pre code')).not.toBeNull())
    const blocks = document.querySelectorAll('pre code')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.className).toContain('language-typescript')
    expect(blocks[0]?.textContent).toBe(source)
    expect(blocks[0]?.querySelector('.hljs-keyword')).not.toBeNull()
  })

  it('marks local-only documents and notes a cut-short text', async () => {
    stubFetch(() =>
      json(200, note({ source: { kind: 'keep', name: 'keep' }, allowLlm: false, truncated: true, content: 'Short', totalChars: 250000 })),
    )
    render(<DocumentScreen id={7} />)

    expect(await screen.findByText(/Local only/)).toBeTruthy()
    expect(screen.getByText('This document is long. Showing the first 5 of 250,000 characters.')).toBeTruthy()
  })

  it('never renders raw HTML, loads no images and keeps only web links as links', async () => {
    stubFetch(() =>
      json(
        200,
        note({
          content: [
            '<script>window.hacked = true</script><b class="raw">bold</b>',
            '',
            '![chart](https://example.com/chart.png) ![local](attachments/a.png)',
            '',
            '[site](https://example.com) [other note](Other%20note.md) [bad](javascript:alert(1))',
          ].join('\n'),
        }),
      ),
    )
    render(<DocumentScreen id={7} />)
    await screen.findByRole('heading', { level: 1, name: 'Pythia' })
    // Wait for the lazily loaded body, so the checks below are not vacuous.
    await screen.findByRole('link', { name: 'site' })

    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('b.raw')).toBeNull()
    expect(document.querySelector('img')).toBeNull()

    const site = screen.getByRole('link', { name: 'site' })
    expect(site.getAttribute('href')).toBe('https://example.com')
    expect(site.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('link', { name: /Image: chart/ }).getAttribute('href')).toBe('https://example.com/chart.png')
    expect(screen.getByText('[Image: local]')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'other note' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(screen.getByText('other note')).toBeTruthy()
  })

  it('says when the document is gone, without Retry', async () => {
    stubFetch(() => json(404, { error: { code: 'not_found', message: 'Document not found' } }))
    render(<DocumentScreen id={7} />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t in the index anymore/)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('retries after a server error', async () => {
    let calls = 0
    stubFetch(() => {
      calls += 1
      return calls === 1 ? json(500, { error: { code: 'internal', message: 'Internal server error' } }) : json(200, note())
    })
    render(<DocumentScreen id={7} />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t open/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Pythia' })).toBeTruthy()
    expect(calls).toBe(2)
  })

  it('reads the saved copy while offline without calling the server', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await offlineDb().documents.put({
      id: 7,
      sourceKind: 'obsidian',
      sourceName: 'vault',
      path: 'Kitchen/Sourdough.md',
      title: 'Sourdough',
      language: 'markdown',
      allowLlm: true,
      mtime: null,
      updatedAt: '2026-11-26T00:00:00.000Z',
      content: '## Steps\n\nFeed the starter.',
      truncated: false,
    })
    const { fn } = stubFetch(() => json(200, note()))
    render(<DocumentScreen id={7} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Sourdough' })).toBeTruthy()
    expect(screen.getByText('Saved copy')).toBeTruthy()
    expect(await screen.findByRole('heading', { level: 3, name: 'Steps' })).toBeTruthy()
    expect(fn).not.toHaveBeenCalled()
  })

  it('says when an offline document is not saved on the device', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { fn } = stubFetch(() => json(200, note()))
    render(<DocumentScreen id={99} />)

    expect((await screen.findByRole('alert')).textContent).toMatch(/You’re offline, and this document isn’t saved/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('falls back to the saved copy when the server cannot be reached', async () => {
    await offlineDb().documents.put({
      id: 7,
      sourceKind: 'repo',
      sourceName: 'kitchen-app',
      path: 'src/auth.ts',
      title: 'auth.ts',
      language: 'typescript',
      allowLlm: true,
      mtime: null,
      updatedAt: '2026-11-26T00:00:00.000Z',
      content: 'export const a = 1\n',
      truncated: false,
    })
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    render(<DocumentScreen id={7} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'auth.ts' })).toBeTruthy()
    expect(screen.getByText('Saved copy')).toBeTruthy()
  })

  it('copies the file path', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    stubFetch(() => json(200, note()))
    render(<DocumentScreen id={7} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Copy file path' }))
    expect(writeText).toHaveBeenCalledWith('Projects/Pythia.md')
    await waitFor(() => expect(screen.getByText('Path copied')).toBeTruthy())
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('goes to Search when Back has no in-app page to return to', async () => {
    window.history.replaceState(null, '', '/doc/7')
    stubFetch(() => json(200, note()))
    render(<DocumentScreen id={7} />)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(window.location.pathname).toBe('/')
  })
})

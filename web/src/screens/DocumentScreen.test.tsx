import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Backlink, BacklinksResponse } from '../api/backlinks'
import type { DocumentView } from '../api/documents'
import type { RelatedDocument, RelatedResponse } from '../api/related'
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

const relatedBody = (over: Partial<RelatedResponse> = {}): RelatedResponse => ({ documentId: 7, inMap: true, related: [], ...over })
const backlinksBody = (over: Partial<BacklinksResponse> = {}): BacklinksResponse => ({
  supported: true,
  backlinks: [],
  outgoing: [],
  ...over,
})

type Respond = (url: string) => Response | Promise<Response>

/**
 * `respond` answers the document; `related` answers its Related panel (an
 * empty list unless given); `backlinks` answers the backlinks request (no
 * backlinks and no resolved links unless given).
 */
function stubFetch(
  respond: Respond,
  related: Respond = () => json(200, relatedBody()),
  backlinks: Respond = () => json(200, backlinksBody()),
  graph: Respond = () => json(200, { documentId: 7, inMap: true, center: 'doc:7', nodes: [], edges: [], truncated: false }),
) {
  const urls: string[] = []
  const fn = vi.fn(async (url: string) => {
    urls.push(url)
    if (url.endsWith('/related')) return related(url)
    if (url.includes('/backlinks')) return backlinks(url)
    if (url.endsWith('/graph')) return graph(url)
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
    await offlineDb().map.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads the document by id and renders the header and Markdown', async () => {
    const { urls } = stubFetch(() => json(200, note()))
    render(<DocumentScreen id={7} />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Pythia' })).toBeTruthy()
    expect(urls[0]).toBe('/api/documents/7')
    await waitFor(() =>
      expect([...urls].sort()).toEqual([
        '/api/documents/7',
        '/api/documents/7/backlinks',
        '/api/documents/7/graph',
        '/api/documents/7/related',
      ]),
    )
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

  describe('Related panel', () => {
    const neighbour = (over: Partial<RelatedDocument> = {}): RelatedDocument => ({
      documentId: 12,
      source: { kind: 'keep', name: 'keep' },
      path: 'Keep/Sourdough starter.json',
      title: 'Sourdough starter',
      allowLlm: true,
      score: 0.84,
      band: 'strong',
      passage: {
        chunkId: 120,
        headingPath: 'Sourdough starter',
        startLine: null,
        endLine: null,
        text: 'Feed the starter twice a day.',
        truncated: false,
      },
      ...over,
    })

    const list = (): RelatedDocument[] => [
      neighbour(),
      neighbour({
        documentId: 31,
        source: { kind: 'repo', name: 'kitchen-app' },
        path: 'docs/setup.md',
        title: 'Setup',
        allowLlm: false,
        score: 0.74,
        band: 'medium',
        passage: {
          chunkId: 310,
          headingPath: 'Setup > Install',
          startLine: 4,
          endLine: 9,
          text: '<b>Install</b> the <script>app</script> first',
          truncated: true,
        },
      }),
      neighbour({
        documentId: 45,
        source: { kind: 'gdrive', name: 'gdrive' },
        path: 'Recipes/Bread.docx',
        title: 'Bread',
        score: 0.62,
        band: 'weak',
        passage: null,
      }),
    ]

    const panel = async () => screen.findByRole('region', { name: 'Related' })

    it('lists the neighbours with source, title, band and passage, each linking to its document', async () => {
      stubFetch(
        () => json(200, note()),
        () => json(200, relatedBody({ related: list() })),
      )
      render(<DocumentScreen id={7} />)

      const region = await panel()
      const items = await within(region).findAllByRole('listitem')
      expect(items).toHaveLength(3)

      const first = within(items[0]!)
      expect(first.getByText('Keep')).toBeTruthy()
      expect(first.getByText('Strong match')).toBeTruthy()
      expect(first.getByRole('link', { name: 'Sourdough starter' }).getAttribute('href')).toBe('/doc/12')
      expect(first.getByText('Feed the starter twice a day.')).toBeTruthy()

      const second = within(items[1]!)
      expect(second.getByText('kitchen-app')).toBeTruthy()
      expect(second.getByText('Medium match')).toBeTruthy()
      expect(second.getByText(/Local only/)).toBeTruthy()
      expect(second.getByText('Install')).toBeTruthy()
      // Passage text is plain text: markup in it shows as characters, never as elements.
      expect(second.getByText('<b>Install</b> the <script>app</script> first…')).toBeTruthy()
      expect(region.querySelector('b, script')).toBeNull()

      const third = within(items[2]!)
      expect(third.getByText('Drive')).toBeTruthy()
      expect(third.getByText('Weak match')).toBeTruthy()
      expect(third.getByRole('link', { name: 'Bread' }).getAttribute('href')).toBe('/doc/45')
    })

    it('opens a neighbour in place with a plain click', async () => {
      window.history.replaceState(null, '', '/doc/7')
      stubFetch(
        () => json(200, note()),
        () => json(200, relatedBody({ related: list() })),
      )
      render(<DocumentScreen id={7} />)

      fireEvent.click(await within(await panel()).findByRole('link', { name: 'Setup' }), { button: 0 })
      expect(window.location.pathname).toBe('/doc/31')
    })

    it('reaches every neighbour by keyboard, in list order, after the document', async () => {
      stubFetch(
        () => json(200, note({ content: '[site](https://example.com)' })),
        () => json(200, relatedBody({ related: list() })),
      )
      render(<DocumentScreen id={7} />)
      const region = await panel()
      await within(region).findAllByRole('listitem')
      await screen.findByRole('link', { name: 'site' })

      // Tab order is DOM order: no element may jump the queue with a positive tabindex.
      expect(document.querySelector('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])')).toBeNull()
      const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button')]
      const names = focusable.map((el) => el.textContent?.trim())
      const site = names.indexOf('site')
      expect(site).toBeGreaterThan(-1)
      expect(names.slice(site + 1).filter((name) => ['Sourdough starter', 'Setup', 'Bread'].includes(name ?? ''))).toEqual([
        'Sourdough starter',
        'Setup',
        'Bread',
      ])

      const link = within(region).getByRole('link', { name: 'Setup' })
      link.focus()
      expect(document.activeElement).toBe(link)
    })

    it('says so when the document has no neighbours yet', async () => {
      stubFetch(() => json(200, note()))
      render(<DocumentScreen id={7} />)

      expect((await within(await panel()).findByText(/No related documents found/)).textContent).toMatch(
        /when the current index round ends/,
      )
      expect(within(await panel()).queryByRole('list')).toBeNull()
    })

    it('explains a document outside the knowledge map', async () => {
      stubFetch(
        () => json(200, note({ source: { kind: 'repo', name: 'kitchen-app' }, path: 'src/auth.ts', title: 'auth.ts', language: 'typescript' })),
        () => json(200, relatedBody({ inMap: false })),
      )
      render(<DocumentScreen id={7} />)

      expect(await within(await panel()).findByText(/isn’t part of the knowledge map/)).toBeTruthy()
    })

    it('shows an error with Retry and loads the list again', async () => {
      let calls = 0
      stubFetch(
        () => json(200, note()),
        () => {
          calls += 1
          return calls === 1
            ? json(500, { error: { code: 'internal', message: 'Internal server error' } })
            : json(200, relatedBody({ related: list() }))
        },
      )
      render(<DocumentScreen id={7} />)

      const region = await panel()
      expect((await within(region).findByRole('alert')).textContent).toMatch(/Couldn’t load related documents/)
      fireEvent.click(within(region).getByRole('button', { name: 'Retry' }))
      expect(await within(region).findAllByRole('listitem')).toHaveLength(3)
      expect(calls).toBe(2)
    })

    it('says it cannot reach the server when the list request fails', async () => {
      stubFetch(
        () => json(200, note()),
        () => Promise.reject(new TypeError('Failed to fetch')),
      )
      render(<DocumentScreen id={7} />)

      expect((await within(await panel()).findByRole('alert')).textContent).toMatch(/Can’t reach the server/)
    })

    it('says it needs a connection while offline, without calling the server', async () => {
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
        content: 'Feed the starter.',
        truncated: false,
      })
      const { fn } = stubFetch(() => json(200, note()))
      render(<DocumentScreen id={7} />)

      expect(await within(await panel()).findByText('Related documents need a connection.')).toBeTruthy()
      expect(fn).not.toHaveBeenCalled()
    })

    it('is not shown when the document cannot be opened', async () => {
      const { urls } = stubFetch(() => json(404, { error: { code: 'not_found', message: 'Document not found' } }))
      render(<DocumentScreen id={7} />)

      await screen.findByRole('alert')
      expect(screen.queryByRole('region', { name: 'Related' })).toBeNull()
      expect(urls).toEqual(['/api/documents/7'])
    })
  })

  describe('Backlinks panel and note links', () => {
    const backlink = (over: Partial<Backlink> = {}): Backlink => ({
      id: 21,
      source: { kind: 'obsidian', name: 'vault' },
      sourceLabel: 'Obsidian',
      title: 'Bread log',
      allowLlm: true,
      count: 1,
      display: null,
      heading: null,
      passage: { headingPath: 'Bread log > March', text: 'Tried the recipe from [[Pythia]] again.' },
      ...over,
    })

    const list = (): Backlink[] => [
      backlink(),
      backlink({
        id: 22,
        title: 'Kitchen index',
        allowLlm: false,
        count: 3,
        display: 'the server',
        heading: 'Goals',
        passage: { headingPath: 'Kitchen index', text: '<b>See</b> <script>x</script> the server' },
      }),
      backlink({ id: 23, title: 'Weekly review', passage: null }),
    ]

    const panel = async () => screen.findByRole('region', { name: 'Backlinks' })

    it('lists the linking notes in the server’s order, each linking to its document', async () => {
      stubFetch(
        () => json(200, note()),
        undefined,
        () => json(200, backlinksBody({ backlinks: list() })),
      )
      render(<DocumentScreen id={7} />)

      const region = await panel()
      const items = await within(region).findAllByRole('listitem')
      expect(items.map((item) => within(item).getAllByRole('link')[0]?.textContent)).toEqual([
        'Bread log',
        'Kitchen index',
        'Weekly review',
      ])

      const first = within(items[0]!)
      expect(first.getByRole('link', { name: 'Bread log' }).getAttribute('href')).toBe('/doc/21')
      expect(first.getByText('Tried the recipe from [[Pythia]] again.')).toBeTruthy()
      expect(first.queryByText(/Local only/)).toBeNull()

      const second = within(items[1]!)
      expect(second.getByText('as “the server” · to “Goals” · 3 links')).toBeTruthy()
      expect(second.getByText(/Local only/)).toBeTruthy()
      // Passage text is plain text: markup in it shows as characters, never as elements.
      expect(second.getByText('<b>See</b> <script>x</script> the server')).toBeTruthy()
      expect(region.querySelector('b, script')).toBeNull()

      expect(within(items[2]!).getByRole('link', { name: 'Weekly review' }).getAttribute('href')).toBe('/doc/23')
    })

    it('opens a backlink in place with a plain click', async () => {
      window.history.replaceState(null, '', '/doc/7')
      stubFetch(
        () => json(200, note()),
        undefined,
        () => json(200, backlinksBody({ backlinks: list() })),
      )
      render(<DocumentScreen id={7} />)

      fireEvent.click(await within(await panel()).findByRole('link', { name: 'Kitchen index' }), { button: 0 })
      expect(window.location.pathname).toBe('/doc/22')
    })

    it('comes before Related, and every backlink is reached by keyboard after the document', async () => {
      stubFetch(
        () => json(200, note({ content: '[site](https://example.com)' })),
        undefined,
        () => json(200, backlinksBody({ backlinks: list() })),
      )
      render(<DocumentScreen id={7} />)
      const region = await panel()
      await within(region).findAllByRole('listitem')
      await screen.findByRole('link', { name: 'site' })

      const related = await screen.findByRole('region', { name: 'Related' })
      expect(region.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      const names = [...document.querySelectorAll<HTMLElement>('a[href], button')].map((el) => el.textContent?.trim())
      const site = names.indexOf('site')
      expect(site).toBeGreaterThan(-1)
      expect(names.slice(site + 1).filter((name) => ['Bread log', 'Kitchen index', 'Weekly review'].includes(name ?? ''))).toEqual([
        'Bread log',
        'Kitchen index',
        'Weekly review',
      ])
    })

    it('says so when no note links here', async () => {
      stubFetch(() => json(200, note()))
      render(<DocumentScreen id={7} />)

      expect(await within(await panel()).findByText(/No notes link here yet/)).toBeTruthy()
      expect(within(await panel()).queryByRole('list')).toBeNull()
    })

    it('turns links to other notes into document links, and a ghost into muted text', async () => {
      window.history.replaceState(null, '', '/doc/7')
      stubFetch(
        () =>
          json(
            200,
            note({
              content: [
                '# Links',
                '',
                'See [[Bread]], [[Bread#Proofing|proofing]], [[Ghost note]], [kitchen](Kitchen/Index%20page.md), [[Unlisted]] and [[#Links]].',
              ].join('\n'),
            }),
          ),
        undefined,
        () =>
          json(
            200,
            backlinksBody({
              outgoing: [
                { target: 'Bread', heading: null, display: null, documentId: 45 },
                { target: 'Bread', heading: 'Proofing', display: 'proofing', documentId: 45 },
                { target: 'Ghost note', heading: null, display: null, documentId: null },
                { target: 'Kitchen/Index page.md', heading: null, display: 'kitchen', documentId: 12 },
              ],
            }),
          ),
      )
      render(<DocumentScreen id={7} />)

      const bread = await screen.findByRole('link', { name: 'Bread' })
      expect(bread.getAttribute('href')).toBe('/doc/45')
      expect(bread.getAttribute('target')).toBeNull()
      expect(screen.getByRole('link', { name: 'proofing' }).getAttribute('href')).toBe('/doc/45')
      expect(screen.getByRole('link', { name: 'kitchen' }).getAttribute('href')).toBe('/doc/12')
      expect(screen.getByRole('link', { name: 'Links' }).getAttribute('href')).toBe('#h-links')

      const ghost = screen.getByText('Ghost note')
      expect(ghost.tagName).toBe('SPAN')
      expect(ghost.className).toContain('text-muted')
      expect(screen.queryByRole('link', { name: 'Ghost note' })).toBeNull()
      // A link the server did not list stays text, as before.
      expect(screen.getByText('Unlisted').tagName).toBe('SPAN')
      expect(screen.getByText('Unlisted').className).toContain('text-accent-ink')

      fireEvent.click(bread, { button: 0 })
      expect(window.location.pathname).toBe('/doc/45')
    })

    it('is not shown, and asks nothing, for repo and Drive documents', async () => {
      for (const source of [
        { kind: 'repo', name: 'kitchen-app' },
        { kind: 'gdrive', name: 'gdrive' },
      ] as const) {
        const { urls } = stubFetch(() => json(200, note({ source, content: 'See [[Bread]].' })))
        const { unmount } = render(<DocumentScreen id={7} />)

        await screen.findByRole('region', { name: 'Related' })
        expect(screen.queryByRole('region', { name: 'Backlinks' })).toBeNull()
        expect(urls.some((url) => url.includes('/backlinks'))).toBe(false)
        unmount()
      }
    })

    it('is not shown when the server says the document has no note links', async () => {
      stubFetch(
        () => json(200, note()),
        undefined,
        () => json(200, backlinksBody({ supported: false })),
      )
      render(<DocumentScreen id={7} />)

      await screen.findByRole('region', { name: 'Related' })
      await waitFor(() => expect(screen.queryByText('Finding backlinks…')).toBeNull())
      expect(screen.queryByRole('region', { name: 'Backlinks' })).toBeNull()
    })

    it('shows an error with Retry and loads the list again, leaving note links as text meanwhile', async () => {
      let calls = 0
      stubFetch(
        () => json(200, note({ content: 'See [[Bread]].' })),
        undefined,
        () => {
          calls += 1
          return calls === 1
            ? json(500, { error: { code: 'internal', message: 'Internal server error' } })
            : json(
                200,
                backlinksBody({ backlinks: list(), outgoing: [{ target: 'Bread', heading: null, display: null, documentId: 45 }] }),
              )
        },
      )
      render(<DocumentScreen id={7} />)

      const region = await panel()
      expect((await within(region).findByRole('alert')).textContent).toMatch(/Couldn’t load backlinks/)
      expect((await screen.findByText('Bread')).tagName).toBe('SPAN')
      fireEvent.click(within(region).getByRole('button', { name: 'Retry' }))
      expect(await within(region).findAllByRole('listitem')).toHaveLength(3)
      expect((await screen.findByRole('link', { name: 'Bread' })).getAttribute('href')).toBe('/doc/45')
      expect(calls).toBe(2)
    })

    it('says it cannot reach the server when the request fails', async () => {
      stubFetch(
        () => json(200, note()),
        undefined,
        () => Promise.reject(new TypeError('Failed to fetch')),
      )
      render(<DocumentScreen id={7} />)

      expect((await within(await panel()).findByRole('alert')).textContent).toMatch(/Can’t reach the server/)
    })

    it('treats an unexpected answer as an error', async () => {
      stubFetch(
        () => json(200, note()),
        undefined,
        () => json(200, { related: [] }),
      )
      render(<DocumentScreen id={7} />)

      expect((await within(await panel()).findByRole('alert')).textContent).toMatch(/Couldn’t load backlinks/)
    })

    it('says it needs a connection while offline, keeping note links as text', async () => {
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
        content: 'Feed the starter, see [[Bread]].',
        truncated: false,
      })
      const { fn } = stubFetch(() => json(200, note()))
      render(<DocumentScreen id={7} />)

      expect(await within(await panel()).findByText('Backlinks need a connection.')).toBeTruthy()
      expect((await screen.findByText('Bread')).tagName).toBe('SPAN')
      expect(fn).not.toHaveBeenCalled()
    })

    it('resolves backlinks and note links offline from the synced map rows (T72)', async () => {
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
        content: 'Feed the starter, see [[Bread]].',
        truncated: false,
      })
      const mapEntry = (id: number, path: string, title: string, target: string) => ({
        id,
        sourceKind: 'obsidian' as const,
        sourceName: 'vault',
        path,
        title,
        allowLlm: true,
        inMap: true,
        neighbours: [],
        links: [{ kind: 'wikilink' as const, target, heading: null, display: null }],
      })
      await offlineDb().map.bulkPut([
        mapEntry(7, 'Kitchen/Sourdough.md', 'Sourdough', 'Bread'),
        mapEntry(9, 'Kitchen/Bread.md', 'Bread', 'Sourdough'),
      ])
      const { fn } = stubFetch(() => json(200, note()))
      render(<DocumentScreen id={7} />)

      const backlinksPanel = await panel()
      expect((await within(backlinksPanel).findByRole('link', { name: /Bread/ })).getAttribute('href')).toBe('/doc/9')
      expect(within(backlinksPanel).queryByText('Backlinks need a connection.')).toBeNull()
      expect(fn).not.toHaveBeenCalled()
    })
  })
})

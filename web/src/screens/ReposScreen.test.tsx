import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoInfo, RepoOverview } from '../api/repos'
import type { RepoStatus } from '../api/repoSync'
import type { CountedLlmExclusion } from '../api/settings'
import { PINS_KEY, readPinnedRepos } from '../repos/pins'
import { REPOS_WIDE_QUERY } from '../repos/format'
import { ReposScreen } from './ReposScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({
  name: 'kitchen-app',
  files: 3,
  chunks: 9,
  updatedAt: '2026-11-21T08:00:00.000Z',
  ...over,
})

const summaryText = (name: string, languages: string, readme = 'Recipe planner with shopping lists.') =>
  [
    `Repository: ${name} (branch main)`,
    'Indexed files: 3',
    `Languages: ${languages}`,
    `README:\n# ${name}\n\n${readme}`,
    'Dependencies:\npackage.json dependencies: react',
    'Files:\nsrc/ (3 files)\nREADME.md\npackage.json',
  ].join('\n\n')

const overview = (name = 'kitchen-app', languages = 'typescript (2), tsx (1), css (1), markdown (1)', over: Partial<RepoOverview> = {}): RepoOverview => ({
  ...repo({ name }),
  summary: { documentId: 30, allowLlm: true, text: summaryText(name, languages) },
  ...over,
})

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  name: 'kitchen-app',
  state: 'healthy',
  reason: null,
  lastSyncAt: '2026-11-26T23:42:00.000Z',
  documents: 4,
  chunks: 9,
  syncing: false,
  ...over,
})

const statusBody = (...repos: RepoStatus[]) => ({ reachable: true, sources: [], repos, activity: [] })

type Route = (init: RequestInit | undefined) => Response

/** Routes are keyed "GET /path" or "PUT /path"; anything else answers 404. */
function stubApi(routes: Record<string, Route>) {
  const calls: Array<{ key: string; body: unknown }> = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const route = routes[key]
    return route === undefined ? json(404, { error: { code: 'not_found', message: 'Not found' } }) : route(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn, count: (key: string) => calls.filter((call) => call.key === key).length }
}

const listOf = (...repos: RepoInfo[]) => () => json(200, { repos })
const rulesOf = (...exclusions: CountedLlmExclusion[]) => () => json(200, { exclusions })

/** Two repos with overviews, status and an empty rule list. */
function standardRoutes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    'GET /api/repos': listOf(repo({ name: 'zeta', files: 1, chunks: 1, updatedAt: null }), repo()),
    'GET /api/repos/kitchen-app': () => json(200, overview()),
    'GET /api/repos/zeta': () => json(200, overview('zeta', 'python (4)')),
    'GET /api/status': () => json(200, statusBody(status(), status({ name: 'zeta', lastSyncAt: null }))),
    'GET /api/settings/llm-exclusions': rulesOf(),
    ...over,
  }
}

/** `matchMedia` where only the Repos side-by-side width matches (or nothing does). */
function stubWidth(wide: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: wide && query === REPOS_WIDE_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

const cards = () => screen.getAllByRole('article')

async function openDetail(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('region', { name })
}

describe('ReposScreen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('lists repos sorted by name with counts, languages, description and offline state', async () => {
    stubApi(standardRoutes())
    render(<ReposScreen />)
    // Both stub overviews share the README line, so each card shows it once.
    expect(await screen.findAllByText(/Recipe planner with shopping lists/)).toHaveLength(2)
    const [kitchen, zeta] = cards()
    expect(within(kitchen!).getByRole('heading').textContent).toBe('kitchen-app')
    expect(within(zeta!).getByRole('heading').textContent).toBe('zeta')
    expect(within(kitchen!).getByText('3 files indexed · 9 chunks')).toBeTruthy()
    expect(within(zeta!).getByText('1 file indexed · 1 chunk')).toBeTruthy()
    // tsx counts as TypeScript; README and manifest languages are left out.
    expect(within(within(kitchen!).getByRole('list', { name: 'Languages' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'TypeScript',
      'CSS',
    ])
    expect(kitchen!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-21T08:00:00.000Z')
    expect(within(zeta!).getByText('Not indexed yet')).toBeTruthy()
    expect(within(kitchen!).getByText('Online only')).toBeTruthy()
    expect(screen.getByText('2 repos indexed. Code, README and manifests only.')).toBeTruthy()
  })

  it('filters by name or language and with the language chips', async () => {
    stubApi(standardRoutes())
    render(<ReposScreen />)
    const chips = within(await screen.findByRole('group', { name: 'Filter by language' }))
    await waitFor(() => expect(chips.getByRole('button', { name: /Python/ })).toBeTruthy())
    expect(chips.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['All· 2', 'CSS· 1', 'Python· 1', 'TypeScript· 1'])
    expect(chips.getByRole('button', { name: /All/ }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(chips.getByRole('button', { name: /Python/ }))
    expect(chips.getByRole('button', { name: /Python/ }).getAttribute('aria-pressed')).toBe('true')
    expect(cards().map((card) => within(card).getByRole('heading').textContent)).toEqual(['zeta'])
    fireEvent.click(chips.getByRole('button', { name: /Python/ }))
    expect(cards()).toHaveLength(2)

    const filter = screen.getByLabelText('Filter repos')
    fireEvent.change(filter, { target: { value: 'KITCH' } })
    expect(cards().map((card) => within(card).getByRole('heading').textContent)).toEqual(['kitchen-app'])
    fireEvent.change(filter, { target: { value: 'python' } })
    expect(cards().map((card) => within(card).getByRole('heading').textContent)).toEqual(['zeta'])
    fireEvent.change(filter, { target: { value: 'nothing-like-this' } })
    expect(screen.getByText('No repo matches this filter.')).toBeTruthy()
  })

  it('opens the detail panel in place of the list on narrow screens, with Back', async () => {
    stubApi(standardRoutes())
    render(<ReposScreen />)
    await screen.findAllByText(/Recipe planner/)
    const panel = await openDetail('kitchen-app')
    expect(screen.queryByRole('article')).toBeNull()

    expect(within(panel).getByText('GitHub repo · main')).toBeTruthy()
    expect(within(panel).getByRole('img').getAttribute('aria-label')).toBe('TypeScript 75 percent, CSS 25 percent')
    const stats = within(panel).getAllByRole('definition').map((dd) => dd.textContent)
    expect(stats[0]).toBe('3')
    expect(stats[1]).toBe('9')
    expect(panel.querySelector('dd time[datetime="2026-11-26T23:42:00.000Z"]')).toBeTruthy()
    const indexed = within(within(panel).getByRole('list', { name: 'Indexed folders and files' })).getAllByRole('listitem')
    expect(indexed.map((li) => li.textContent)).toEqual(['src/ · 3 files', 'README.md', 'package.json'])
    expect(within(panel).getByText(/^Skipped: /)).toBeTruthy()
    expect(within(panel).getByRole('link', { name: 'Open overview' }).getAttribute('href')).toBe('/doc/30')

    fireEvent.click(screen.getByRole('button', { name: 'Back to repos' }))
    expect(cards()).toHaveLength(2)
    expect(screen.queryByRole('region', { name: 'kitchen-app' })).toBeNull()
  })

  it('shows the list and the selected repo side by side on wide screens', async () => {
    stubWidth(true)
    stubApi(standardRoutes())
    render(<ReposScreen />)
    const aside = await screen.findByRole('complementary', { name: 'Repo details' })
    expect(within(aside).getByRole('heading', { level: 2 }).textContent).toBe('kitchen-app')
    expect(screen.getByRole('button', { name: 'kitchen-app' }).getAttribute('aria-current')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'zeta' }))
    expect(within(aside).getByRole('heading', { level: 2 }).textContent).toBe('zeta')
    expect(screen.getByRole('button', { name: 'zeta' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'kitchen-app' }).getAttribute('aria-current')).toBeNull()
    expect(within(aside).getByText('Not yet')).toBeTruthy()
    expect(cards()).toHaveLength(2)
  })

  it('handles an overview that failed or has no summary yet', async () => {
    let calls = 0
    stubApi(
      standardRoutes({
        'GET /api/repos/kitchen-app': () => {
          calls += 1
          return calls === 1 ? json(500, { error: { code: 'internal', message: 'Internal server error' } }) : json(200, overview())
        },
        'GET /api/repos/zeta': () => json(200, overview('zeta', '', { summary: null })),
      }),
    )
    render(<ReposScreen />)
    const zeta = await openDetail('zeta')
    expect(await within(zeta).findByText(/No overview yet/)).toBeTruthy()
    expect((within(zeta).getByRole('button', { name: 'Open overview' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back to repos' }))

    const kitchen = await openDetail('kitchen-app')
    expect(within(kitchen).getByText('Couldn’t load the overview. Try again.')).toBeTruthy()
    fireEvent.click(within(kitchen).getByRole('button', { name: 'Retry' }))
    expect(await within(kitchen).findByText(/Recipe planner/)).toBeTruthy()
  })

  it('locks a repo by adding its rule and keeps every other rule', async () => {
    const others: CountedLlmExclusion[] = [
      { kind: 'folder', path: 'Private', documents: 4 },
      { kind: 'tag', path: 'health', documents: 2 },
      { kind: 'repo', path: 'zeta', documents: 1 },
    ]
    const { calls } = stubApi(
      standardRoutes({
        'GET /api/settings/llm-exclusions': rulesOf(...others),
        'PUT /api/settings/llm-exclusions': (init) => {
          const body = JSON.parse(String(init?.body)) as { exclusions: CountedLlmExclusion[] }
          return json(200, { exclusions: body.exclusions.map((rule) => ({ ...rule, documents: 3 })) })
        },
      }),
    )
    render(<ReposScreen />)
    const panel = await openDetail('kitchen-app')
    const toggle = await within(panel).findByRole('switch', { name: 'Allow Ask to read this repo' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    expect(within(panel).getByText('Locked: its text never goes to Gemini.')).toBeTruthy()
    const put = calls.find((call) => call.key === 'PUT /api/settings/llm-exclusions')
    expect(put?.body).toEqual({
      exclusions: [
        { kind: 'folder', path: 'Private' },
        { kind: 'tag', path: 'health' },
        { kind: 'repo', path: 'zeta' },
        { kind: 'repo', path: 'kitchen-app' },
      ],
    })
  })

  it('allows a locked repo by removing only its rule', async () => {
    const { calls } = stubApi(
      standardRoutes({
        'GET /api/settings/llm-exclusions': rulesOf(
          { kind: 'note', path: 'Diary.md', documents: 1 },
          { kind: 'repo', path: 'Kitchen-App', documents: 3 },
          { kind: 'keep', path: 'keep', documents: 9 },
        ),
        'PUT /api/settings/llm-exclusions': (init) => json(200, JSON.parse(String(init?.body))),
      }),
    )
    render(<ReposScreen />)
    const panel = await openDetail('kitchen-app')
    const toggle = within(panel).getByRole('switch', { name: 'Allow Ask to read this repo' })
    // The rule's name differs in case; it still covers the repo.
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(calls.find((call) => call.key === 'PUT /api/settings/llm-exclusions')?.body).toEqual({
      exclusions: [
        { kind: 'note', path: 'Diary.md' },
        { kind: 'keep', path: 'keep' },
      ],
    })
  })

  it('keeps the switch as it was when saving fails', async () => {
    stubApi(
      standardRoutes({
        'PUT /api/settings/llm-exclusions': () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
      }),
    )
    render(<ReposScreen />)
    const panel = await openDetail('kitchen-app')
    const toggle = within(panel).getByRole('switch', { name: 'Allow Ask to read this repo' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    expect(await within(panel).findByText('Couldn’t save the change. Try again.')).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables the switch when the rules cannot be read, and shows what the overview says', async () => {
    const { count } = stubApi(
      standardRoutes({
        'GET /api/settings/llm-exclusions': () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
        'GET /api/repos/kitchen-app': () =>
          json(200, overview('kitchen-app', 'typescript (1)', { summary: { documentId: 30, allowLlm: false, text: 'Repository: kitchen-app' } })),
      }),
    )
    render(<ReposScreen />)
    const panel = await openDetail('kitchen-app')
    expect(await within(panel).findByText('Couldn’t load the Gemini rules, so this switch is unavailable.')).toBeTruthy()
    const toggle = within(panel).getByRole('switch', { name: 'Allow Ask to read this repo' }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    expect(count('PUT /api/settings/llm-exclusions')).toBe(0)
  })

  it('re-syncs a repo, polls status until it stops syncing and refreshes the numbers', async () => {
    let polls = 0
    let listCalls = 0
    const { count } = stubApi(
      standardRoutes({
        'GET /api/repos': () => {
          listCalls += 1
          return listOf(repo({ name: 'zeta', files: 1, chunks: 1, updatedAt: null }), repo({ files: listCalls === 1 ? 3 : 5 }))()
        },
        'POST /api/repos/kitchen-app/sync': () => json(202, { name: 'kitchen-app', started: true, state: 'started' }),
        'GET /api/status': () => {
          polls += 1
          // First read is the page load; then one poll still syncing, then done.
          return json(200, statusBody(status({ syncing: polls === 2, lastSyncAt: polls >= 3 ? '2026-11-27T01:00:00.000Z' : null })))
        },
      }),
    )
    render(<ReposScreen pollMs={5} />)
    const panel = await openDetail('kitchen-app')
    fireEvent.click(within(panel).getByRole('button', { name: 'Re-sync' }))
    expect(await within(panel).findByRole('button', { name: 'Syncing…' })).toBeTruthy()
    expect(await within(panel).findByText('Synced. The index is up to date.')).toBeTruthy()
    expect(count('POST /api/repos/kitchen-app/sync')).toBe(1)
    expect(polls).toBe(3)
    // The page stops asking once the run is over.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
    expect(polls).toBe(3)
    expect(within(panel).getAllByRole('definition')[0]?.textContent).toBe('5')
    expect(panel.querySelector('dd time[datetime="2026-11-27T01:00:00.000Z"]')).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Re-sync' })).toBeTruthy()
  })

  it('reports a re-sync that ends in an error', async () => {
    let polls = 0
    stubApi(
      standardRoutes({
        'POST /api/repos/kitchen-app/sync': () => json(202, { name: 'kitchen-app', started: false, state: 'running' }),
        'GET /api/status': () => {
          polls += 1
          return json(200, statusBody(status(polls === 1 ? {} : { state: 'error', reason: 'fetch_failed' })))
        },
      }),
    )
    render(<ReposScreen pollMs={5} />)
    const panel = await openDetail('kitchen-app')
    fireEvent.click(within(panel).getByRole('button', { name: 'Re-sync' }))
    expect(await within(panel).findByText('The sync failed (fetch_failed). The previous index is kept.')).toBeTruthy()
  })

  it('explains a re-sync the server refuses', async () => {
    stubApi(
      standardRoutes({
        'POST /api/repos/kitchen-app/sync': () => json(409, { error: { code: 'repos_off', message: 'Repo fetching is off on this server' } }),
        'POST /api/repos/zeta/sync': () => json(404, { error: { code: 'not_found', message: 'Repo not found' } }),
      }),
    )
    render(<ReposScreen />)
    const kitchen = await openDetail('kitchen-app')
    fireEvent.click(within(kitchen).getByRole('button', { name: 'Re-sync' }))
    expect(await within(kitchen).findByText('Repo fetching is off on this server, so it can’t re-sync.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to repos' }))
    const zeta = await openDetail('zeta')
    fireEvent.click(within(zeta).getByRole('button', { name: 'Re-sync' }))
    expect(await within(zeta).findByText(/isn’t in the server’s repo list anymore/)).toBeTruthy()
  })

  it('encodes the repo name in the overview and sync URLs', async () => {
    const { count } = stubApi({
      'GET /api/repos': listOf(repo({ name: 'a b' })),
      'GET /api/repos/a%20b': () => json(200, overview('a b')),
      'POST /api/repos/a%20b/sync': () => json(202, { name: 'a b', started: true, state: 'started' }),
    })
    render(<ReposScreen pollMs={60_000} />)
    const panel = await openDetail('a b')
    fireEvent.click(within(panel).getByRole('button', { name: 'Re-sync' }))
    await within(panel).findByRole('button', { name: 'Syncing…' })
    expect(count('GET /api/repos/a%20b')).toBe(1)
    expect(count('POST /api/repos/a%20b/sync')).toBe(1)
  })

  it('pins and unpins a repo on this device only', async () => {
    const { fn } = stubApi(standardRoutes())
    render(<ReposScreen />)
    const panel = await openDetail('kitchen-app')
    await within(panel).findByText(/Recipe planner/)
    const callsBefore = fn.mock.calls.length

    const pin = within(panel).getByRole('button', { name: 'Pin kitchen-app for offline' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pin)
    const unpin = within(panel).getByRole('button', { name: 'Unpin kitchen-app' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem(PINS_KEY) ?? 'null')).toEqual(['kitchen-app'])

    fireEvent.click(screen.getByRole('button', { name: 'Back to repos' }))
    // Not in the offline copy yet: the card says Pinned, not Cached.
    expect(within(cards()[0]!).getByText('Pinned')).toBeTruthy()
    expect(within(cards()[1]!).getByText('Online only')).toBeTruthy()

    const again = await openDetail('kitchen-app')
    fireEvent.click(within(again).getByRole('button', { name: 'Unpin kitchen-app' }))
    expect(readPinnedRepos()).toEqual([])
    // Pinning never talks to the server.
    expect(fn.mock.calls.length).toBe(callsBefore)
  })

  it('restores pins from storage and ignores a corrupt value', async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(['kitchen-app']))
    stubApi(standardRoutes())
    const { unmount } = render(<ReposScreen />)
    expect(await within((await screen.findAllByRole('article'))[0]!).findByText('Pinned')).toBeTruthy()
    unmount()

    localStorage.setItem(PINS_KEY, '{not json')
    render(<ReposScreen />)
    const [first] = await screen.findAllByRole('article')
    expect(within(first!).getByText('Online only')).toBeTruthy()
  })

  it('shows an empty state when no repos are indexed', async () => {
    stubApi(standardRoutes({ 'GET /api/repos': listOf() }))
    render(<ReposScreen />)
    expect(await screen.findByText('No repos indexed yet')).toBeTruthy()
  })

  it('shows a list error and retries', async () => {
    let calls = 0
    stubApi(
      standardRoutes({
        'GET /api/repos': () => {
          calls += 1
          return calls === 1 ? json(500, { error: { code: 'internal', message: 'Internal server error' } }) : listOf(repo())()
        },
      }),
    )
    render(<ReposScreen />)
    expect(await screen.findByText('Couldn’t load repos. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'kitchen-app' })).toBeTruthy()
  })

  it('explains a server without repo indexing', async () => {
    stubApi({})
    render(<ReposScreen />)
    expect(await screen.findByText('Repo indexing isn’t set up on the server yet.')).toBeTruthy()
  })

  it('does not fetch while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { fn } = stubApi(standardRoutes())
    render(<ReposScreen />)
    expect(await screen.findByText('You’re offline. The repo list needs a connection.')).toBeTruthy()
    await waitFor(() => expect(fn).not.toHaveBeenCalled())
  })
})

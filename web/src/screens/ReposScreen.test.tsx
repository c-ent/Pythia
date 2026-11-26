import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoInfo, RepoOverview } from '../api/repos'
import { PINS_KEY, readPinnedRepos } from '../repos/pins'
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

const overview = (over: Partial<RepoOverview> = {}): RepoOverview => ({
  ...repo(),
  summary: { documentId: 30, allowLlm: true, text: 'Repository: kitchen-app\nLanguages: TypeScript' },
  ...over,
})

function stubApi(routes: Record<string, () => Response>) {
  const urls: string[] = []
  const fn = vi.fn(async (url: string) => {
    urls.push(url)
    const route = routes[url]
    return route === undefined ? json(404, { error: { code: 'not_found', message: 'Not found' } }) : route()
  })
  vi.stubGlobal('fetch', fn)
  return { urls, fn }
}

const listOf = (...repos: RepoInfo[]) => () => json(200, { repos })

describe('ReposScreen', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists repos sorted by name with file and chunk counts', async () => {
    stubApi({ '/api/repos': listOf(repo({ name: 'zeta', files: 1, chunks: 1 }), repo()) })
    render(<ReposScreen />)
    const items = await screen.findAllByRole('article')
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual(['kitchen-app', 'zeta'])
    expect(within(items[0]!).getByText(/3 files · 9 chunks/)).toBeTruthy()
    expect(within(items[1]!).getByText(/1 file · 1 chunk/)).toBeTruthy()
    expect(items[0]!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-21T08:00:00.000Z')
  })

  it('says when a repo has not been indexed yet', async () => {
    stubApi({ '/api/repos': listOf(repo({ files: 0, chunks: 0, updatedAt: null })) })
    render(<ReposScreen />)
    expect(await screen.findByText(/not indexed yet/)).toBeTruthy()
  })

  it('shows an empty state when no repos are indexed', async () => {
    stubApi({ '/api/repos': listOf() })
    render(<ReposScreen />)
    expect(await screen.findByText('No repos indexed yet')).toBeTruthy()
  })

  it('loads the overview once on first expand and collapses it again', async () => {
    const { urls } = stubApi({
      '/api/repos': listOf(repo()),
      '/api/repos/kitchen-app': () => json(200, overview()),
    })
    render(<ReposScreen />)
    const toggle = await screen.findByRole('button', { name: /Show overview/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(await screen.findByText(/Languages: TypeScript/)).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/never sent to Gemini/)).toBeNull()

    fireEvent.click(toggle)
    expect(screen.queryByText(/Languages: TypeScript/)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText(/Languages: TypeScript/)).toBeTruthy()
    expect(urls.filter((url) => url === '/api/repos/kitchen-app')).toHaveLength(1)
  })

  it('encodes the repo name in the overview URL', async () => {
    const { urls } = stubApi({
      '/api/repos': listOf(repo({ name: 'a b' })),
      '/api/repos/a%20b': () => json(200, overview({ name: 'a b' })),
    })
    render(<ReposScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Show overview/ }))
    await screen.findByText(/Languages: TypeScript/)
    expect(urls).toContain('/api/repos/a%20b')
  })

  it('marks a local-only overview and handles a missing summary', async () => {
    stubApi({
      '/api/repos': listOf(repo(), repo({ name: 'fresh' })),
      '/api/repos/kitchen-app': () =>
        json(200, overview({ summary: { documentId: 30, allowLlm: false, text: 'Repository: kitchen-app' } })),
      '/api/repos/fresh': () => json(200, overview({ name: 'fresh', summary: null })),
    })
    render(<ReposScreen />)
    // Sorted by name: "fresh" comes before "kitchen-app".
    const [second, first] = await screen.findAllByRole('article')
    fireEvent.click(within(first!).getByRole('button', { name: /Show overview/ }))
    expect(await within(first!).findByText(/never sent to Gemini/)).toBeTruthy()
    fireEvent.click(within(second!).getByRole('button', { name: /Show overview/ }))
    expect(await within(second!).findByText(/No overview yet/)).toBeTruthy()
  })

  it('shows an overview error and retries', async () => {
    let calls = 0
    stubApi({
      '/api/repos': listOf(repo()),
      '/api/repos/kitchen-app': () => {
        calls += 1
        return calls === 1 ? json(500, { error: { code: 'internal', message: 'Internal server error' } }) : json(200, overview())
      },
    })
    render(<ReposScreen />)
    fireEvent.click(await screen.findByRole('button', { name: /Show overview/ }))
    expect(await screen.findByText('Couldn’t load the overview. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Languages: TypeScript/)).toBeTruthy()
  })

  it('pins and unpins a repo on this device only', async () => {
    const { fn } = stubApi({ '/api/repos': listOf(repo(), repo({ name: 'zeta' })) })
    render(<ReposScreen />)
    const pin = await screen.findByRole('button', { name: 'Pin kitchen-app for offline' })
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    const callsBefore = fn.mock.calls.length

    fireEvent.click(pin)
    const unpin = screen.getByRole('button', { name: 'Unpin kitchen-app' })
    expect(unpin.getAttribute('aria-pressed')).toBe('true')
    expect(JSON.parse(localStorage.getItem(PINS_KEY) ?? 'null')).toEqual(['kitchen-app'])

    fireEvent.click(screen.getByRole('button', { name: 'Pin zeta for offline' }))
    expect(readPinnedRepos()).toEqual(['kitchen-app', 'zeta'])

    fireEvent.click(unpin)
    expect(screen.getByRole('button', { name: 'Pin kitchen-app for offline' })).toBeTruthy()
    expect(readPinnedRepos()).toEqual(['zeta'])
    // Pinning never talks to the server.
    expect(fn.mock.calls.length).toBe(callsBefore)
  })

  it('restores pins from storage and ignores a corrupt value', async () => {
    localStorage.setItem(PINS_KEY, JSON.stringify(['kitchen-app']))
    stubApi({ '/api/repos': listOf(repo()) })
    const { unmount } = render(<ReposScreen />)
    expect((await screen.findByRole('button', { name: 'Unpin kitchen-app' })).getAttribute('aria-pressed')).toBe('true')
    unmount()

    localStorage.setItem(PINS_KEY, '{not json')
    render(<ReposScreen />)
    expect(await screen.findByRole('button', { name: 'Pin kitchen-app for offline' })).toBeTruthy()
  })

  it('shows a list error and retries', async () => {
    let calls = 0
    stubApi({
      '/api/repos': () => {
        calls += 1
        return calls === 1 ? json(500, { error: { code: 'internal', message: 'Internal server error' } }) : listOf(repo())()
      },
    })
    render(<ReposScreen />)
    expect(await screen.findByText('Couldn’t load repos. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'kitchen-app' })).toBeTruthy()
  })

  it('explains a server without repo indexing', async () => {
    stubApi({})
    render(<ReposScreen />)
    expect(await screen.findByText('Repo indexing isn’t set up on the server yet.')).toBeTruthy()
  })

  it('does not fetch while offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { fn } = stubApi({ '/api/repos': listOf(repo()) })
    render(<ReposScreen />)
    expect(await screen.findByText('You’re offline. The repo list needs a connection.')).toBeTruthy()
    await waitFor(() => expect(fn).not.toHaveBeenCalled())
  })
})

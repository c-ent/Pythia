import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { LlmExclusion } from '../api/settings'
import { PINS_KEY, readPinnedRepos } from '../repos/pins'
import { checkExclusionPath, exclusionErrorMessage, normalizeVaultPath } from './exclusionPaths'
import { SettingsScreen } from './SettingsScreen'

// jsdom has no `navigator.storage`; each test defines the one it needs.
function stubStorage(storage: Partial<StorageManager>): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, get: () => storage })
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const EXCLUSIONS_URL = '/api/settings/llm-exclusions'

type Handler = (init?: RequestInit) => Response | Promise<Response>

/** Routes are keyed `METHOD url`; a list of handlers is answered in order, the last one repeating. */
function stubApi(routes: Record<string, Handler | Handler[]>) {
  const calls: { key: string; init?: RequestInit }[] = []
  const seen = new Map<string, number>()
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, init })
    const route = routes[key]
    if (route === undefined) return json(404, { error: { code: 'not_found', message: 'Not found' } })
    const list = Array.isArray(route) ? route : [route]
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    return list[Math.min(n, list.length - 1)]!(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

/** A server that keeps the list in memory, like the real one (sorted, folders first). */
function stubExclusionServer(initial: LlmExclusion[] = []) {
  let stored = [...initial]
  const puts: LlmExclusion[][] = []
  const api = stubApi({
    [`GET ${EXCLUSIONS_URL}`]: () => json(200, { exclusions: stored }),
    [`PUT ${EXCLUSIONS_URL}`]: (init) => {
      const body = JSON.parse(String(init?.body)) as { exclusions: LlmExclusion[] }
      puts.push(body.exclusions)
      stored = [...body.exclusions].sort((a, b) =>
        a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : a.path.localeCompare(b.path),
      )
      return json(200, { exclusions: stored })
    },
  })
  return { ...api, puts }
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Kept away from Gemini' })
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    localStorage.clear()
    stubExclusionServer()
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'storage')
    Reflect.deleteProperty(navigator, 'onLine')
    vi.restoreAllMocks()
  })

  it('signs out', () => {
    stubStorage({})
    const onSignOut = vi.fn()
    render(<SettingsScreen onSignOut={onSignOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('shows storage use and whether the browser keeps the data', async () => {
    stubStorage({
      estimate: () => Promise.resolve({ usage: 5 * 1024 * 1024, quota: 2 * 1024 ** 3 }),
      persisted: () => Promise.resolve(true),
    })
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(await screen.findByText('5.0 MB of 2.0 GB')).toBeTruthy()
    expect(screen.getByText(/Yes, offline data is not cleared/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Keep offline data' })).toBeNull()
  })

  it('asks the browser to keep offline data', async () => {
    const persist = vi.fn(() => Promise.resolve(true))
    stubStorage({ persisted: () => Promise.resolve(false), persist })
    render(<SettingsScreen onSignOut={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep offline data' }))
    expect(await screen.findByText(/Yes, offline data is not cleared/)).toBeTruthy()
    expect(persist).toHaveBeenCalledOnce()
  })

  it('explains a refused persistence request', async () => {
    stubStorage({ persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) })
    render(<SettingsScreen onSignOut={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Keep offline data' }))
    expect(await screen.findByText(/add Pythia to the Home Screen/)).toBeTruthy()
  })

  it('says when storage details are unknown', async () => {
    stubStorage({})
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(await screen.findByText('Storage used')).toBeTruthy()
    expect(screen.getAllByText('Unknown')).toHaveLength(2)
  })

  it('lists pinned repos and unpins one', async () => {
    stubStorage({})
    localStorage.setItem(PINS_KEY, JSON.stringify(['alpha', 'beta']))
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(screen.getByText('alpha')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Unpin alpha' }))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(readPinnedRepos()).toEqual(['beta'])
  })

  it('points to the Repos screen when nothing is pinned', () => {
    stubStorage({})
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(screen.getByText(/Pin a repo on the Repos screen/)).toBeTruthy()
  })
})

describe('Kept away from Gemini panel', () => {
  beforeEach(() => {
    localStorage.clear()
    stubStorage({})
  })
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'storage')
    Reflect.deleteProperty(navigator, 'onLine')
    vi.restoreAllMocks()
  })

  it('says when nothing is kept away', async () => {
    stubExclusionServer()
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(await within(panel()).findByText(/Nothing is kept away/)).toBeTruthy()
  })

  it('lists folders and single notes from the server', async () => {
    stubExclusionServer([
      { kind: 'folder', path: 'Private' },
      { kind: 'note', path: 'Journal/2026-11-26.md' },
    ])
    render(<SettingsScreen onSignOut={() => {}} />)
    const list = await within(panel()).findByRole('list', { name: 'Kept away from Gemini' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toContain('Folder')
    expect(items[0]!.textContent).toContain('Private/')
    expect(items[1]!.textContent).toContain('Note')
    expect(items[1]!.textContent).toContain('Journal/2026-11-26.md')
  })

  it('adds a folder, sending the whole list with the path cleaned', async () => {
    const server = stubExclusionServer([{ kind: 'note', path: 'Inbox/todo.md' }])
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    await within(region).findByText('Inbox/todo.md')
    fireEvent.change(within(region).getByLabelText('Path in the vault'), { target: { value: ' ./Work\\Clients/ ' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }))
    expect(await within(region).findByText('Work/Clients/')).toBeTruthy()
    expect(server.puts).toEqual([
      [
        { kind: 'note', path: 'Inbox/todo.md' },
        { kind: 'folder', path: 'Work/Clients' },
      ],
    ])
    expect((within(region).getByLabelText('Path in the vault') as HTMLInputElement).value).toBe('')
  })

  it('adds a single note', async () => {
    const server = stubExclusionServer()
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    await within(region).findByText(/Nothing is kept away/)
    fireEvent.change(within(region).getByLabelText('Type'), { target: { value: 'note' } })
    fireEvent.change(within(region).getByLabelText('Path in the vault'), { target: { value: 'Health/Doctor.md' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }))
    expect(await within(region).findByText('Health/Doctor.md')).toBeTruthy()
    expect(server.puts).toEqual([[{ kind: 'note', path: 'Health/Doctor.md' }]])
  })

  it('refuses a note path without .md and does not call the server', async () => {
    const server = stubExclusionServer()
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    await within(region).findByText(/Nothing is kept away/)
    fireEvent.change(within(region).getByLabelText('Type'), { target: { value: 'note' } })
    fireEvent.change(within(region).getByLabelText('Path in the vault'), { target: { value: 'Health/Doctor' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }))
    expect(within(region).getByRole('alert').textContent).toMatch(/ends in \.md/)
    expect(server.puts).toEqual([])
  })

  it('removes an item', async () => {
    const server = stubExclusionServer([
      { kind: 'folder', path: 'Private' },
      { kind: 'folder', path: 'Health' },
    ])
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    fireEvent.click(await within(region).findByRole('button', { name: 'Remove Private' }))
    await waitFor(() => expect(within(region).queryByText('Private/')).toBeNull())
    expect(within(region).getByText('Health/')).toBeTruthy()
    expect(server.puts).toEqual([[{ kind: 'folder', path: 'Health' }]])
  })

  it('keeps the list and shows an error when saving fails', async () => {
    stubApi({
      [`GET ${EXCLUSIONS_URL}`]: () => json(200, { exclusions: [{ kind: 'folder', path: 'Private' }] }),
      [`PUT ${EXCLUSIONS_URL}`]: () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
    })
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    fireEvent.click(await within(region).findByRole('button', { name: 'Remove Private' }))
    expect(await within(region).findByText('Couldn’t save the change. Try again.')).toBeTruthy()
    expect(within(region).getByText('Private/')).toBeTruthy()

    fireEvent.change(within(region).getByLabelText('Path in the vault'), { target: { value: 'Health' } })
    fireEvent.click(within(region).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(within(region).getByRole('button', { name: 'Add' })).not.toHaveProperty('disabled', true))
    expect(within(region).queryByText('Health/')).toBeNull()
    // A failed add keeps the typed path so the owner can try again.
    expect((within(region).getByLabelText('Path in the vault') as HTMLInputElement).value).toBe('Health')
  })

  it('shows a load error and retries', async () => {
    stubApi({
      [`GET ${EXCLUSIONS_URL}`]: [
        () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
        () => json(200, { exclusions: [{ kind: 'folder', path: 'Private' }] }),
      ],
    })
    render(<SettingsScreen onSignOut={() => {}} />)
    const region = panel()
    expect(await within(region).findByText('Couldn’t load the list. Try again.')).toBeTruthy()
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }))
    expect(await within(region).findByText('Private/')).toBeTruthy()
  })

  it('does not call the server while offline', () => {
    setOnline(false)
    const server = stubExclusionServer()
    render(<SettingsScreen onSignOut={() => {}} />)
    expect(within(panel()).getByText(/You’re offline. This list needs a connection./)).toBeTruthy()
    expect(server.calls.filter((call) => call.key.endsWith(EXCLUSIONS_URL))).toEqual([])
  })
})

describe('checkExclusionPath', () => {
  const list: LlmExclusion[] = [{ kind: 'folder', path: 'Private' }]

  it('cleans the path like the server does', () => {
    expect(normalizeVaultPath(' ./a\\b//c/ ')).toBe('a/b/c')
    expect(normalizeVaultPath('a/../b')).toBeNull()
    expect(normalizeVaultPath(' / ')).toBeNull()
    expect(checkExclusionPath('folder', '/Work/', list)).toEqual({ path: 'Work' })
  })

  it('rejects empty, outside-the-vault, duplicate and bad note paths', () => {
    expect(checkExclusionPath('folder', '  ', list)).toEqual({ error: 'Type a folder or note path.' })
    expect(checkExclusionPath('folder', '../etc', list)).toHaveProperty('error')
    expect(checkExclusionPath('folder', 'private/', list)).toEqual({ error: 'That is already on the list.' })
    expect(checkExclusionPath('note', 'Private', list)).toHaveProperty('error')
    expect(checkExclusionPath('note', 'Private.MD', list)).toEqual({ path: 'Private.MD' })
    expect(checkExclusionPath('folder', 'a\u0007b', list)).toEqual({ error: 'That path can’t be used.' })
  })
})

describe('exclusionErrorMessage', () => {
  it('maps status codes to messages', () => {
    expect(exclusionErrorMessage(new ApiError(0, 'network', 'x'), 'load')).toMatch(/Can’t reach the server/)
    expect(exclusionErrorMessage(new ApiError(404, 'not_found', 'x'), 'load')).toMatch(/isn’t available/)
    expect(exclusionErrorMessage(new ApiError(400, 'invalid_input', 'exclusions.0.path: bad'), 'save')).toBe(
      'The server refused the list: exclusions.0.path: bad',
    )
    expect(exclusionErrorMessage(new Error('x'), 'save')).toBe('Couldn’t save the change. Try again.')
  })
})

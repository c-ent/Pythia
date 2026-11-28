import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { KeepImportResult } from '../api/imports'
import { SYNC_POLL_MS, type ActivityEvent, type RepoHealth, type SourceHealth } from '../api/status'
import { statusErrorText } from '../sources/format'
import { resetSyncNow } from '../sources/syncNow'
import { ACTIVITY_PREVIEW, SourcesScreen } from './SourcesScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const obsidian = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  id: 'obsidian',
  kind: 'obsidian',
  state: 'healthy',
  reason: null,
  lastSyncAt: '2026-11-27T07:42:00.000Z',
  schedule: { kind: 'watch', everyMinutes: null },
  documents: 48,
  chunks: 210,
  syncing: false,
  ...over,
})

const github = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  id: 'github',
  kind: 'repo',
  state: 'error',
  reason: '1 repo failing',
  lastSyncAt: '2026-11-27T07:00:00.000Z',
  schedule: { kind: 'interval', everyMinutes: 60 },
  documents: 120,
  chunks: 640,
  syncing: false,
  ...over,
})

const keep = (over: Partial<SourceHealth> = {}): SourceHealth => ({
  id: 'keep',
  kind: 'keep',
  state: 'manual',
  reason: null,
  lastSyncAt: null,
  schedule: { kind: 'manual', everyMinutes: null },
  documents: 3,
  chunks: 3,
  syncing: false,
  ...over,
})

const repo = (name: string, over: Partial<RepoHealth> = {}): RepoHealth => ({
  name,
  state: 'healthy',
  reason: null,
  lastSyncAt: '2026-11-27T07:00:00.000Z',
  documents: 60,
  chunks: 320,
  syncing: false,
  ...over,
})

const event = (id: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  at: '2026-11-27T07:42:00.000Z',
  kind: 'vault_synced',
  source: 'obsidian',
  count: 2,
  message: null,
  ...over,
})

const statusBody = (over: Record<string, unknown> = {}) => ({
  reachable: true,
  checkedAt: '2026-11-27T08:00:00.000Z',
  gemini: { available: true },
  devices: { active: 2 },
  documents: { obsidian: 48, keep: 3, repo: 120, chat: 0 },
  syncing: false,
  sources: [obsidian(), github(), keep()],
  repos: [repo('alpha'), repo('beta', { state: 'error', reason: 'fetch failed' })],
  activity: [event(2, { kind: 'secrets_blocked', source: 'alpha', count: 2 }), event(1)],
  ...over,
})

const keepResult = (over: Partial<KeepImportResult> = {}): KeepImportResult => ({
  notes: 12,
  indexed: 4,
  unchanged: 8,
  deleted: 0,
  failed: 0,
  skipped: { trashed: 0, empty: 0, invalid: 0, blocked: 0, tooLarge: 0 },
  ...over,
})

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
  const count = (key: string): number => calls.filter((call) => call.key === key).length
  return { calls, fn, count }
}

const statusOf = (over: Record<string, unknown> = {}) => () => json(200, statusBody(over))
const syncAll = () => screen.getByRole('button', { name: /Sync all|Syncing…/ }) as HTMLButtonElement
const card = (name: string) => within(screen.getByRole('article', { name }))
/** Waits for the status to load and the card to appear. */
const findCard = async (name: string) => within(await screen.findByRole('article', { name }))
const importForm = () => within(screen.getByRole('region', { name: 'Import a file' }))

describe('statusErrorText', () => {
  it('maps errors to messages', () => {
    expect(statusErrorText(new ApiError(0, 'network', 'x'))).toMatch(/Can’t reach the server/)
    expect(statusErrorText(new ApiError(404, 'not_found', 'x'))).toMatch(/isn’t available on this server/)
    expect(statusErrorText(new ApiError(500, 'internal', 'x'))).toBe('Couldn’t load the sources. Try again.')
    expect(statusErrorText(new Error('boom'))).toBe('Couldn’t load the sources. Try again.')
  })
})

describe('SourcesScreen', () => {
  afterEach(() => {
    resetSyncNow()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows each source with its health, chat history and recent activity', async () => {
    stubApi({ 'GET /api/status': statusOf() })
    render(<SourcesScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Sources and sync' })).toBeTruthy()

    const vault = await findCard('Obsidian vault')
    expect(vault.getByText('48 notes · 210 chunks · watching for changes')).toBeTruthy()
    expect(vault.getByText(/^Healthy · /)).toBeTruthy()

    const repos = card('GitHub repos')
    expect(repos.getByText('2 repos · 120 files · every hour')).toBeTruthy()
    expect(repos.getByText('Error · 1 repo failing')).toBeTruthy()
    expect(repos.getByText('1 repo failing: beta')).toBeTruthy()
    expect(repos.getByRole('link', { name: 'Manage' }).getAttribute('href')).toBe('/repos')

    const notes = card('Google Keep')
    expect(notes.getByText('Takeout import · 3 notes · not imported yet')).toBeTruthy()
    expect(notes.getByText('Manual · not imported yet')).toBeTruthy()

    expect(card('Chat history').getByText('Coming later')).toBeTruthy()

    const activity = within(screen.getByRole('list', { name: 'Activity' }))
    const rows = activity.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Skipped secrets')).toBeTruthy()
    expect(within(rows[0]!).getByText(/2 chunks blocked · in alpha/)).toBeTruthy()
    expect(within(rows[1]!).getByText('Vault synced')).toBeTruthy()
    expect(rows[1]!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-27T07:42:00.000Z')
    expect(syncAll().disabled).toBe(false)
  })

  it('shows a Google Drive card and its pull in the activity when the server has Drive', async () => {
    const drive: SourceHealth = {
      id: 'gdrive',
      kind: 'gdrive',
      state: 'healthy',
      reason: null,
      lastSyncAt: '2026-11-27T07:30:00.000Z',
      schedule: { kind: 'interval', everyMinutes: 30 },
      documents: 12,
      chunks: 40,
      syncing: false,
    }
    stubApi({
      'GET /api/status': statusOf({
        documents: { obsidian: 48, keep: 3, repo: 120, chat: 0, gdrive: 12 },
        sources: [obsidian(), github(), keep(), drive],
        activity: [event(3, { kind: 'drive_pulled', source: 'gdrive', count: 3 })],
      }),
    })
    render(<SourcesScreen />)
    const driveCard = await findCard('Google Drive')
    expect(driveCard.getByText('12 files · 40 chunks · pulled every 30 min')).toBeTruthy()
    const activity = within(screen.getByRole('list', { name: 'Activity' }))
    expect(activity.getByText('Drive synced')).toBeTruthy()
    expect(activity.getByText(/3 files changed/)).toBeTruthy()
  })

  it('marks unconfigured sources off and has nothing to sync without a vault or repos', async () => {
    stubApi({
      'GET /api/status': statusOf({
        sources: [obsidian({ state: 'off' }), github({ state: 'off', reason: null }), keep()],
        repos: [],
        activity: [],
      }),
    })
    render(<SourcesScreen />)
    expect((await findCard('Obsidian vault')).getByText('Not configured on the server.')).toBeTruthy()
    expect(card('GitHub repos').queryByRole('link', { name: 'Manage' })).toBeNull()
    expect(screen.getByText(/Nothing yet. Syncs, imports and blocked secrets show here./)).toBeTruthy()
    expect(syncAll().disabled).toBe(true)
    expect(syncAll().title).toMatch(/No vault or repos/)
  })

  it('shows a status error and retries', async () => {
    stubApi({
      'GET /api/status': [() => json(500, { error: { code: 'internal', message: 'Internal server error' } }), statusOf()],
    })
    render(<SourcesScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Couldn’t load the sources/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await findCard('Obsidian vault')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when the server has no status route yet', async () => {
    stubApi({})
    render(<SourcesScreen />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t available on this server yet/)
  })

  it('disables Sync all and the import offline without calling the server', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { fn } = stubApi({})
    render(<SourcesScreen />)
    expect(screen.getByText(/You’re offline. Sync and source status need a connection./)).toBeTruthy()
    expect(screen.getByText(/Importing needs a connection/)).toBeTruthy()
    expect(syncAll().disabled).toBe(true)
    fireEvent.click(syncAll())
    expect(fn).not.toHaveBeenCalled()
  })

  it('runs Sync all, shows it running, and is ready again when the server is done', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { count } = stubApi({
      'GET /api/status': statusOf(),
      'POST /api/sync-now': async () => {
        await held
        return json(202, { started: true, vault: 'started', repos: 'started' })
      },
    })
    render(<SourcesScreen />)
    await findCard('Obsidian vault')

    fireEvent.click(syncAll())
    await waitFor(() => expect(syncAll().textContent).toBe('Syncing…'))
    expect(syncAll().disabled).toBe(true)

    release()
    await waitFor(() => expect(syncAll().textContent).toBe('Sync all'))
    expect(syncAll().disabled).toBe(false)
    expect(count('POST /api/sync-now')).toBe(1)
    // Read on mount, by Sync now, and again by this page on each change event.
    expect(count('GET /api/status')).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a failed Sync all', async () => {
    stubApi({
      'GET /api/status': statusOf(),
      'POST /api/sync-now': () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
    })
    render(<SourcesScreen />)
    await findCard('Obsidian vault')
    fireEvent.click(syncAll())
    expect((await screen.findByRole('alert')).textContent).toMatch('Sync now failed. Try again.')
  })

  it('polls while the server syncs and stops once it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { count } = stubApi({
      'GET /api/status': [
        statusOf({ syncing: true, sources: [obsidian({ syncing: true }), github(), keep()] }),
        statusOf(),
      ],
    })
    render(<SourcesScreen />)
    expect((await findCard('Obsidian vault')).getByText('Syncing…')).toBeTruthy()
    expect(syncAll().disabled).toBe(true)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_POLL_MS)
    })
    expect(await card('Obsidian vault').findByText(/^Healthy · /)).toBeTruthy()
    expect(syncAll().disabled).toBe(false)
    expect(count('GET /api/status')).toBe(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_POLL_MS * 3)
    })
    expect(count('GET /api/status')).toBe(2)
  })

  it('imports a Keep zip, shows the summary and rereads the status', async () => {
    const { calls, count } = stubApi({
      'GET /api/status': statusOf(),
      'POST /api/import/keep': () => json(200, keepResult({ failed: 1 })),
    })
    render(<SourcesScreen />)
    await findCard('Obsidian vault')

    const form = importForm()
    const submit = form.getByRole('button', { name: 'Import' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    const file = new File(['PK'], 'takeout.zip', { type: 'application/zip' })
    fireEvent.change(form.getByLabelText('Keep Takeout zip'), { target: { files: [file] } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    expect(await form.findByText(/12 notes imported · 4 new or changed · 8 unchanged\./)).toBeTruthy()
    expect(form.getByText(/1 note could not be indexed/)).toBeTruthy()
    const upload = calls.find((call) => call.key === 'POST /api/import/keep')
    expect(upload?.init?.body).toBe(file)
    expect(new Headers(upload?.init?.headers).get('content-type')).toBe('application/zip')
    await waitFor(() => expect(count('GET /api/status')).toBe(2))
    expect(submit.disabled).toBe(true)
  })

  it('shows the server message when the zip is rejected', async () => {
    stubApi({
      'GET /api/status': statusOf(),
      'POST /api/import/keep': () =>
        json(400, { error: { code: 'bad_request', message: 'No Google Keep notes found in this zip' } }),
    })
    render(<SourcesScreen />)
    await findCard('Obsidian vault')
    const form = importForm()
    fireEvent.change(form.getByLabelText('Keep Takeout zip'), {
      target: { files: [new File(['PK'], 'takeout.zip', { type: 'application/zip' })] },
    })
    fireEvent.click(form.getByRole('button', { name: 'Import' }))
    expect((await form.findByRole('alert')).textContent).toMatch('No Google Keep notes found in this zip')
  })

  it('takes the Keep card’s Import to the file field', async () => {
    stubApi({ 'GET /api/status': statusOf() })
    render(<SourcesScreen />)
    fireEvent.click((await findCard('Google Keep')).getByRole('button', { name: 'Import' }))
    expect(document.activeElement).toBe(importForm().getByLabelText('Keep Takeout zip'))
  })

  it('shows the first activity rows and the rest on demand', async () => {
    const events = Array.from({ length: ACTIVITY_PREVIEW + 2 }, (_, i) => event(100 - i))
    stubApi({ 'GET /api/status': statusOf({ activity: events }) })
    render(<SourcesScreen />)
    const list = await screen.findByRole('list', { name: 'Activity' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(ACTIVITY_PREVIEW)

    const toggle = screen.getByRole('button', { name: `Show all ${events.length}` })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(within(list).getAllByRole('listitem')).toHaveLength(events.length)
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(ACTIVITY_PREVIEW)
  })
})

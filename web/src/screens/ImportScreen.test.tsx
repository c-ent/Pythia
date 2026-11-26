import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import type { IndexStatus, KeepImportResult, SourceStatus } from '../api/imports'
import { ImportScreen, REINDEX_POLL_MS } from './ImportScreen'
import { importErrorMessage, importSummary } from './importMessages'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const source = (over: Partial<SourceStatus> = {}): SourceStatus => ({
  kind: 'obsidian',
  name: 'vault',
  enabled: true,
  documents: 1200,
  chunks: 5400,
  updatedAt: '2026-11-25T10:00:00.000Z',
  ...over,
})

const indexStatus = (over: Partial<IndexStatus> = {}): IndexStatus => ({
  sources: [source()],
  reindex: { vault: 'idle', repos: 'off' },
  ...over,
})

const result = (over: Partial<KeepImportResult> = {}): KeepImportResult => ({
  notes: 12,
  indexed: 4,
  unchanged: 8,
  deleted: 0,
  failed: 0,
  skipped: { trashed: 0, empty: 0, invalid: 0, blocked: 0, tooLarge: 0 },
  ...over,
})

type Handler = (init?: RequestInit) => Response

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

const statusOf = (index: IndexStatus) => () => json(200, index)

function chooseZip(): File {
  const file = new File(['PK'], 'takeout.zip', { type: 'application/zip' })
  fireEvent.change(screen.getByLabelText('Keep Takeout zip'), { target: { files: [file] } })
  return file
}

describe('importErrorMessage', () => {
  it('maps status codes to messages', () => {
    expect(importErrorMessage(new ApiError(0, 'network', 'x'))).toMatch(/Can’t reach the server/)
    expect(importErrorMessage(new ApiError(400, 'bad_request', 'No Google Keep notes found in this zip'))).toBe(
      'No Google Keep notes found in this zip',
    )
    expect(importErrorMessage(new ApiError(409, 'conflict', 'An import is already running'))).toBe(
      'An import is already running',
    )
    expect(importErrorMessage(new ApiError(413, 'too_large', 'x'))).toMatch(/too large/)
    expect(importErrorMessage(new ApiError(404, 'not_found', 'x'))).toMatch(/isn’t set up/)
    expect(importErrorMessage(new ApiError(500, 'internal', 'x'))).toBe('The import failed. Try again.')
    expect(importErrorMessage(new Error('boom'))).toBe('The import failed. Try again.')
  })
})

describe('importSummary', () => {
  it('lists only the non-zero counts', () => {
    expect(importSummary(result())).toBe('12 notes imported · 4 new or changed · 8 unchanged.')
  })

  it('counts skipped notes but not invalid files', () => {
    const summary = importSummary(
      result({
        notes: 1,
        indexed: 1,
        unchanged: 0,
        deleted: 2,
        skipped: { trashed: 1, empty: 1, invalid: 5, blocked: 1, tooLarge: 1 },
      }),
    )
    expect(summary).toBe('1 note imported · 1 new or changed · 2 removed · 4 skipped.')
  })
})

describe('ImportScreen', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows sources with counts and last update', async () => {
    stubApi({
      'GET /api/index/status': statusOf(
        indexStatus({
          sources: [source(), source({ kind: 'keep', name: 'keep', enabled: false, documents: 3, chunks: 3, updatedAt: null })],
        }),
      ),
    })
    render(<ImportScreen />)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Obsidian')).toBeTruthy()
    expect(within(rows[0]!).getByText('1,200')).toBeTruthy()
    expect(within(rows[0]!).getByText('5,400')).toBeTruthy()
    expect(rows[0]!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-25T10:00:00.000Z')
    expect(within(rows[1]!).getByText('(off)')).toBeTruthy()
    expect(within(rows[1]!).getByText('never')).toBeTruthy()
  })

  it('shows an empty state when nothing is indexed', async () => {
    stubApi({ 'GET /api/index/status': statusOf(indexStatus({ sources: [] })) })
    render(<ImportScreen />)
    expect(await screen.findByText('Nothing indexed yet.')).toBeTruthy()
  })

  it('shows a status error and retries', async () => {
    stubApi({
      'GET /api/index/status': [
        () => json(500, { error: { code: 'internal', message: 'Internal server error' } }),
        statusOf(indexStatus()),
      ],
    })
    render(<ImportScreen />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Couldn’t load index status/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })

  it('says when the server has no import service', async () => {
    stubApi({})
    render(<ImportScreen />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t available on this server/)
  })

  it('uploads a zip, shows the summary and refreshes the status', async () => {
    const { calls } = stubApi({
      'GET /api/index/status': statusOf(indexStatus()),
      'POST /api/import/keep': () => json(200, result({ failed: 1 })),
    })
    render(<ImportScreen />)
    await screen.findByRole('table')
    const button = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    const file = chooseZip()
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    expect(await screen.findByText(/12 notes imported · 4 new or changed · 8 unchanged\./)).toBeTruthy()
    expect(screen.getByText(/1 note could not be indexed/)).toBeTruthy()
    const upload = calls.find((call) => call.key === 'POST /api/import/keep')
    expect(upload?.init?.body).toBe(file)
    expect(new Headers(upload?.init?.headers).get('content-type')).toBe('application/zip')
    await waitFor(() => expect(calls.filter((call) => call.key === 'GET /api/index/status')).toHaveLength(2))
    expect(button.disabled).toBe(true)
  })

  it('shows the server message when the zip is rejected', async () => {
    stubApi({
      'GET /api/index/status': statusOf(indexStatus()),
      'POST /api/import/keep': () =>
        json(400, { error: { code: 'bad_request', message: 'No Google Keep notes found in this zip' } }),
    })
    render(<ImportScreen />)
    await screen.findByRole('table')
    chooseZip()
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect((await screen.findByRole('alert')).textContent).toMatch('No Google Keep notes found in this zip')
  })

  it('disables re-index when no vault or repos are configured', async () => {
    stubApi({ 'GET /api/index/status': statusOf(indexStatus({ reindex: { vault: 'off', repos: 'off' } })) })
    render(<ImportScreen />)
    await screen.findByRole('table')
    expect((screen.getByRole('button', { name: 'Re-index' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts a re-index and polls until it finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { calls } = stubApi({
      'GET /api/index/status': [statusOf(indexStatus()), statusOf(indexStatus())],
      'POST /api/index/reindex': () => json(202, { reindex: { vault: 'running', repos: 'off' } }),
    })
    render(<ImportScreen />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'Re-index' }))

    const running = await screen.findByRole('button', { name: 'Re-indexing…' })
    expect((running as HTMLButtonElement).disabled).toBe(true)
    expect(calls.filter((call) => call.key === 'GET /api/index/status')).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REINDEX_POLL_MS)
    })
    expect(await screen.findByRole('button', { name: 'Re-index' })).toBeTruthy()
    expect(calls.filter((call) => call.key === 'GET /api/index/status')).toHaveLength(2)
  })

  it('stays usable offline without calling the server', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { fn } = stubApi({})
    render(<ImportScreen />)
    expect(screen.getByText(/Index status needs a connection/)).toBeTruthy()
    expect(screen.getByText(/Importing needs a connection/)).toBeTruthy()
    expect(fn).not.toHaveBeenCalled()
  })
})

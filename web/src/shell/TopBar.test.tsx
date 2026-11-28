import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SourceHealth } from '../api/status'
import { MobileTopBar } from './Navigation'
import { StatusMenu } from './StatusMenu'
import { SyncMenu } from './SyncMenu'
import { TopBar } from './TopBar'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serverDetailsPayload(
  health: 'ok' | 'warning' | 'broken' = 'ok',
  checks: Record<string, { state: 'ok' | 'broken' | 'off'; reason: string | null; remainingCore?: number }> = {
    postgres: { state: 'ok', reason: null },
    ollama: { state: 'ok', reason: null },
    gemini: { state: 'ok', reason: null },
    github: { state: 'ok', reason: null, remainingCore: 4990 },
    vault: { state: 'ok', reason: null },
    sources: { state: 'ok', reason: null },
    oracle: { state: 'off', reason: null },
  },
) {
  return {
    sampledAt: '2026-11-28T00:00:00.000Z',
    checkedAt: '2026-11-28T00:00:00.000Z',
    health,
    cpu: { cores: 4, loadAverage: [0.1, 0.2, 0.3], busyPercent: 10 },
    memory: { totalBytes: 1000, availableBytes: 500, usedBytes: 500 },
    disk: { totalBytes: 2000, freeBytes: 1000, usedBytes: 1000 },
    databaseBytes: 100,
    uptimeSeconds: { host: 1000, app: 100 },
    version: { app: '1.0.0', commit: null },
    checks,
  }
}

describe('StatusMenu', () => {
  it('renders a single status button for ok, warning, broken, unreachable, and offline', () => {
    const { rerender } = render(<StatusMenu online reachable health="ok" />)
    expect(screen.getByRole('button', { name: 'Status: Online' }).textContent).toBe('Online')

    rerender(<StatusMenu online reachable health="warning" />)
    expect(screen.getByRole('button', { name: 'Status: Warning' }).textContent).toBe('Warning')

    rerender(<StatusMenu online reachable health="broken" brokenChecks={['Ollama', 'PostgreSQL']} />)
    expect(screen.getByRole('button', { name: 'Server issue: Ollama, PostgreSQL' }).textContent).toBe('Server issue')

    rerender(<StatusMenu online reachable health="broken" />)
    expect(screen.getByRole('button', { name: 'Server issue' }).textContent).toBe('Server issue')

    rerender(<StatusMenu online reachable={false} health="broken" brokenChecks={['Ollama']} />)
    expect(screen.getByRole('button', { name: 'Status: Server unreachable' }).textContent).toBe('Server unreachable')

    rerender(<StatusMenu online={false} reachable health="broken" brokenChecks={['Ollama']} />)
    expect(screen.getByRole('button', { name: 'Status: Offline' }).textContent).toBe('Offline')
  })

  it('opens a popover on click showing server, services, and API key checks', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/status/server') {
        return json(
          200,
          serverDetailsPayload('broken', {
            postgres: { state: 'ok', reason: null },
            ollama: { state: 'broken', reason: 'TimeoutError' },
            gemini: { state: 'broken', reason: 'KeyUnavailable' },
            github: { state: 'ok', reason: null, remainingCore: 4990 },
            vault: { state: 'ok', reason: null },
            sources: { state: 'ok', reason: null },
            oracle: { state: 'off', reason: null },
          }),
        )
      }
      return json(404, {})
    })
    vi.stubGlobal('fetch', fetch)

    render(<StatusMenu online reachable health="broken" brokenChecks={['Ollama', 'Gemini']} gemini={false} />)
    expect(fetch).not.toHaveBeenCalled()

    const trigger = screen.getByRole('button', { name: 'Server issue: Ollama, Gemini' })
    fireEvent.click(trigger)

    const panel = await screen.findByRole('region', { name: 'Server issue' })
    expect(within(panel).getByText('Pythia server')).toBeTruthy()
    expect(await within(panel).findByText('PostgreSQL')).toBeTruthy()
    expect(within(panel).getByText('Ollama')).toBeTruthy()
    expect(within(panel).getByText('TimeoutError')).toBeTruthy()
    expect(within(panel).getByText('Gemini')).toBeTruthy()
    expect(within(panel).getByText('KeyUnavailable')).toBeTruthy()
    expect(within(panel).getByText('GitHub token')).toBeTruthy()
    expect(within(panel).getByText('4,990 GitHub requests remaining')).toBeTruthy()
    expect(within(panel).queryByText('Sources')).toBeNull()
    expect(within(panel).getByRole('link', { name: 'Server details' }).getAttribute('href')).toBe('/settings/server')
    expect(within(panel).getByRole('link', { name: 'Gemini access' }).getAttribute('href')).toBe('/settings/gemini')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Server issue' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on outside click and shows offline guidance without fetching', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    render(
      <div>
        <button type="button">Outside</button>
        <StatusMenu online={false} reachable health="ok" />
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Status: Offline' }))
    const panel = screen.getByRole('region', { name: 'Offline' })
    expect(within(panel).getByText(/Live server and key checks need a connection/)).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('region', { name: 'Offline' })).toBeNull()
  })

  it('renders a single unified status button in both TopBar and MobileTopBar', () => {
    const { rerender } = render(
      <>
        <TopBar online reachable health="broken" brokenChecks={['Ollama']} gemini />
        <MobileTopBar online reachable health="broken" brokenChecks={['Ollama']} gemini />
      </>,
    )
    expect(screen.getAllByRole('button', { name: 'Server issue: Ollama' })).toHaveLength(2)
    expect(screen.queryByText('Gemini on')).toBeNull()

    rerender(
      <>
        <TopBar online reachable health="warning" brokenChecks={['Ollama']} gemini />
        <MobileTopBar online reachable health="warning" brokenChecks={['Ollama']} gemini />
      </>,
    )
    expect(screen.getAllByRole('button', { name: 'Status: Warning' })).toHaveLength(2)

    rerender(
      <>
        <TopBar online reachable health="ok" gemini />
        <MobileTopBar online reachable health="ok" gemini />
      </>,
    )
    expect(screen.getAllByRole('button', { name: 'Status: Online' })).toHaveLength(2)
  })

  it('warns on Oracle warning and refreshes details on demand', async () => {
    const fetch = vi.fn(async () => json(200, serverDetailsPayload('warning')))
    vi.stubGlobal('fetch', fetch)

    render(<StatusMenu online reachable health="warning" />)
    fireEvent.click(screen.getByRole('button', { name: 'Status: Warning' }))

    expect(await screen.findByText(/Oracle Cloud plan has a warning/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})

const sampleSources: SourceHealth[] = [
  {
    id: 'obsidian',
    kind: 'obsidian',
    state: 'healthy',
    reason: null,
    lastSyncAt: '2026-11-28T00:00:00.000Z',
    schedule: { kind: 'watch', everyMinutes: null },
    documents: 10,
    chunks: 40,
    syncing: false,
  },
  {
    id: 'gdrive',
    kind: 'gdrive',
    state: 'error',
    reason: 'Drive round failed: DrivePullError',
    lastSyncAt: null,
    schedule: { kind: 'interval', everyMinutes: 60 },
    documents: 0,
    chunks: 0,
    syncing: false,
  },
]

describe('SyncMenu', () => {
  it('renders Synced, Syncing, and Sync issue states and hides when offline or unreachable', () => {
    const healthySources = sampleSources.map((s) => ({ ...s, state: 'healthy' as const, reason: null }))
    const { rerender } = render(<SyncMenu online reachable sources={healthySources} />)
    expect(screen.getByRole('button', { name: 'Sync: Synced' }).textContent).toBe('Synced')

    rerender(<SyncMenu online reachable sources={healthySources} syncing />)
    expect(screen.getByRole('button', { name: 'Sync: Syncing' }).textContent).toBe('Syncing')

    rerender(<SyncMenu online reachable sources={sampleSources} />)
    expect(screen.getByRole('button', { name: 'Sync issue: Google Drive' }).textContent).toBe('Sync issue')

    rerender(<SyncMenu online={false} reachable sources={sampleSources} />)
    expect(screen.queryByRole('button', { name: /Sync/ })).toBeNull()

    rerender(<SyncMenu online reachable={false} sources={sampleSources} />)
    expect(screen.queryByRole('button', { name: /Sync/ })).toBeNull()
  })

  it('opens a popover listing each source state and links to Sources and sync', () => {
    render(<SyncMenu online reachable sources={sampleSources} />)
    const trigger = screen.getByRole('button', { name: 'Sync issue: Google Drive' })
    fireEvent.click(trigger)

    const panel = screen.getByRole('region', { name: 'Sync issue' })
    expect(within(panel).getByText('Obsidian vault')).toBeTruthy()
    expect(within(panel).getByText('Google Drive')).toBeTruthy()
    expect(within(panel).getByText('Error · Drive round failed: DrivePullError')).toBeTruthy()
    expect(within(panel).getByRole('link', { name: 'Sources and sync' }).getAttribute('href')).toBe('/sources')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Sync issue' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('shows Syncing with percentage instead of Sync issue while the failing source is retrying', () => {
    const retryingSources: SourceHealth[] = [
      sampleSources[0]!,
      {
        ...sampleSources[1]!,
        syncing: true,
        progress: { stage: 'indexing', done: 14, total: 119 },
      },
    ]
    render(<SyncMenu online reachable sources={retryingSources} syncing />)
    const trigger = screen.getByRole('button', { name: 'Sync: Syncing 12%' })
    expect(trigger.textContent).toBe('Syncing 12%')
    fireEvent.click(trigger)
    const panel = screen.getByRole('region', { name: 'Syncing 12%' })
    expect(within(panel).getByText('Indexing · 12% (14/119)')).toBeTruthy()
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../api/status'
import { ActivityScreen } from './ActivityScreen'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const event = (id: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  at: '2026-11-27T07:42:00.000Z',
  kind: 'vault_synced',
  source: 'obsidian',
  count: 2,
  message: null,
  ...over,
})

const statusWith = (activity: ActivityEvent[]) => ({
  reachable: true,
  checkedAt: '2026-11-27T08:00:00.000Z',
  gemini: { available: true },
  devices: { active: 2 },
  documents: { obsidian: 48, keep: 3, repo: 120, chat: 0 },
  syncing: false,
  sources: [],
  repos: [],
  activity,
})

describe('ActivityScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/sources/activity')
  })

  it('lists every activity event and links back to Sources and sync', async () => {
    const events = Array.from({ length: 12 }, (_, i) => event(100 - i))
    vi.stubGlobal('fetch', vi.fn(async () => json(200, statusWith(events))))

    render(<ActivityScreen />)

    const list = await screen.findByRole('list', { name: 'Activity' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(12)

    const back = screen.getByRole('link', { name: 'Sources and sync' })
    expect(back.getAttribute('href')).toBe('/sources')
    fireEvent.click(back)
    expect(window.location.pathname).toBe('/sources')
  })

  it('shows an empty message when there is no activity yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, statusWith([]))))

    render(<ActivityScreen />)

    expect(await screen.findByText('Nothing yet. Syncs, imports and blocked secrets show here.')).toBeTruthy()
  })
})

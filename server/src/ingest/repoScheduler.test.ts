import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RepoSpec } from './repoConfig.js'
import { RepoSyncError, type SyncResult } from './repoMirror.js'
import { DEFAULT_FETCH_INTERVAL_MS, startRepoScheduler, type RepoRoundResult } from './repoScheduler.js'

const repos: RepoSpec[] = [
  { name: 'a', url: '/tmp/a', branch: null },
  { name: 'b', url: '/tmp/b', branch: 'main' },
]

const ok = (name: string): SyncResult => ({ name, cloned: false, commit: `${name}-sha` })

afterEach(() => {
  vi.useRealTimers()
})

describe('startRepoScheduler', () => {
  it('runs a round at start, one repo at a time, and keeps going past a failure', async () => {
    const order: string[] = []
    const sync = vi.fn(async (spec: RepoSpec) => {
      order.push(spec.name)
      if (spec.name === 'a') throw new RepoSyncError('git clone failed: not found')
      return ok(spec.name)
    })
    const onSynced = vi.fn()
    const rounds: RepoRoundResult[] = []
    const scheduler = startRepoScheduler({
      repos,
      mirrorsDir: '/m',
      sync,
      onSynced,
      onRound: (round) => rounds.push(round),
    })
    const result = await scheduler.runNow()
    await scheduler.close()

    expect(order).toEqual(['a', 'b'])
    expect(result.synced).toEqual([ok('b')])
    expect(result.failed).toEqual([{ name: 'a', error: 'git clone failed: not found' }])
    expect(onSynced).toHaveBeenCalledWith(ok('b'), repos[1])
    expect(rounds).toHaveLength(1)
  })

  it('never overlaps rounds: runNow during a round returns the same round', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sync = vi.fn(async (spec: RepoSpec) => {
      await gate
      return ok(spec.name)
    })
    const scheduler = startRepoScheduler({ repos, mirrorsDir: '/m', sync, onRound: () => {} })
    const first = scheduler.runNow()
    const second = scheduler.runNow()
    expect(second).toBe(first)
    release()
    await first
    expect(sync).toHaveBeenCalledTimes(2)
    await scheduler.close()
  })

  it('counts a failing onSynced as that repo failing', async () => {
    const scheduler = startRepoScheduler({
      repos: [repos[0] as RepoSpec],
      mirrorsDir: '/m',
      sync: async (spec) => ok(spec.name),
      onSynced: () => {
        throw new Error('index failed')
      },
      onRound: () => {},
    })
    const result = await scheduler.runNow()
    await scheduler.close()
    expect(result.failed).toEqual([{ name: 'a', error: 'index failed' }])
  })

  it('fetches again after the interval (30 minutes by default)', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async (spec: RepoSpec) => ok(spec.name))
    const scheduler = startRepoScheduler({ repos, mirrorsDir: '/m', sync, onRound: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_INTERVAL_MS - 1)
    expect(sync).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sync).toHaveBeenCalledTimes(4)
    await scheduler.close()
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_INTERVAL_MS * 2)
    expect(sync).toHaveBeenCalledTimes(4)
  })

  it('does nothing with no repos configured', async () => {
    vi.useFakeTimers()
    const sync = vi.fn(async (spec: RepoSpec) => ok(spec.name))
    const scheduler = startRepoScheduler({ repos: [], mirrorsDir: '/m', sync, onRound: () => {} })
    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_INTERVAL_MS * 3)
    expect(sync).not.toHaveBeenCalled()
    await scheduler.close()
  })
})

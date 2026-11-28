import { describe, expect, it } from 'vitest'
import type { RefreshResult } from '../db/neighbourStore.js'
import { createActivityLog, createMemoryActivityStore } from '../sync/activity.js'
import { createNeighbourRefresher, refreshAfterRounds } from './neighbourRefresh.js'

const deferred = () => {
  let resolve!: (value: RefreshResult) => void
  const promise = new Promise<RefreshResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('createNeighbourRefresher', () => {
  it('folds requests during a refresh into one more run', async () => {
    const runs: Array<ReturnType<typeof deferred>> = []
    const refresher = createNeighbourRefresher(
      () => {
        const next = deferred()
        runs.push(next)
        return next.promise
      },
      { log: () => {} },
    )
    refresher.request()
    refresher.request()
    refresher.request()
    expect(runs).toHaveLength(1)
    runs[0]!.resolve({ refreshed: 1, failed: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(runs).toHaveLength(2)
    runs[1]!.resolve({ refreshed: 0, failed: 0 })
    await refresher.idle()
    expect(runs).toHaveLength(2)
  })

  it('logs counts only and survives a failed refresh', async () => {
    const lines: string[] = []
    let call = 0
    const refresher = createNeighbourRefresher(
      async () => {
        call++
        if (call === 1) throw new TypeError('relation "secret" does not exist')
        return { refreshed: 3, failed: 1 }
      },
      { log: (line) => lines.push(line) },
    )
    refresher.request()
    await refresher.idle()
    refresher.request()
    await refresher.idle()
    expect(lines).toEqual(['map: neighbour refresh failed (TypeError)', 'map: neighbours refreshed for 3 documents, 1 failed'])
  })

  it('logs nothing when nothing changed', async () => {
    const lines: string[] = []
    const refresher = createNeighbourRefresher(async () => ({ refreshed: 0, failed: 0 }), { log: (line) => lines.push(line) })
    refresher.request()
    await refresher.idle()
    expect(lines).toEqual([])
  })
})

describe('refreshAfterRounds', () => {
  it('records the event, then requests a refresh for round-ending events only', async () => {
    const store = createMemoryActivityStore()
    let requests = 0
    const activity = refreshAfterRounds(createActivityLog(store), { request: () => requests++, idle: async () => {} })
    await activity.record({ kind: 'vault_synced', source: 'obsidian', count: 2 })
    await activity.record({ kind: 'secrets_blocked', source: 'obsidian', count: 1 })
    await activity.record({ kind: 'drive_pulled', source: 'gdrive', count: 0 })
    await activity.record({ kind: 'keep_imported', source: 'keep', count: 4 })
    await activity.record({ kind: 'repos_fetched', source: 'github', count: 3 })
    await activity.record({ kind: 'repo_fetched', source: 'pythia', count: 1 })
    await activity.record({ kind: 'sync_error', source: 'gdrive', message: 'Drive round failed: Error' })
    expect(store.rows()).toHaveLength(7)
    expect(requests).toBe(6)
    // The wrapped log still tracks syncs for the Status page.
    expect(activity.lastSynced('obsidian')).not.toBeNull()
  })
})

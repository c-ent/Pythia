import { useEffect } from 'react'
import { offlineDb } from './db'
import { offlineCacheChanged, syncOnce } from './sync'

/** Minimum time between automatic syncs while the app stays open. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000

const NO_PINS: readonly string[] = []

/**
 * Keeps the offline cache current while signed in: syncs on mount, when the
 * browser comes back online, and every few minutes. Failures (offline, server
 * down, no IndexedDB) are quiet; the next trigger tries again from the stored
 * cursor. Pinned repos' files are cached too; changing the pins aborts any
 * running sync and starts a fresh one, which `syncOnce` runs from cursor 0 so
 * unpinned repo files are dropped.
 *
 * `pinnedRepos` must keep its identity until the pins change (`usePinnedRepos`
 * does), or every render restarts the sync.
 */
export function useOfflineSync(enabled = true, pinnedRepos: readonly string[] = NO_PINS): void {
  useEffect(() => {
    if (!enabled || typeof indexedDB === 'undefined') return
    const controller = new AbortController()
    let running = false

    const run = (): void => {
      if (running || !navigator.onLine) return
      running = true
      syncOnce(offlineDb(), { pinnedRepos, signal: controller.signal })
        .then((result) => {
          if (result.updated > 0 || result.removed > 0 || result.reset) offlineCacheChanged()
        })
        .catch(() => {
          // Try again on the next trigger.
        })
        .finally(() => {
          running = false
        })
    }

    run()
    window.addEventListener('online', run)
    const timer = window.setInterval(run, SYNC_INTERVAL_MS)
    return () => {
      controller.abort()
      window.removeEventListener('online', run)
      window.clearInterval(timer)
    }
  }, [enabled, pinnedRepos])
}

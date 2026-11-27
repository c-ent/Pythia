import { useEffect, useState } from 'react'
import { offlineDb } from '../offline/db'
import { readSyncState } from '../offline/sync'

export type PinState = 'cached' | 'pinned' | 'online'

/**
 * Repos whose files the last offline sync stored on this device, or null
 * until read (or without IndexedDB). Read again whenever the pins change.
 */
export function useCachedRepos(pins: readonly string[]): readonly string[] | null {
  const [cached, setCached] = useState<readonly string[] | null>(null)
  useEffect(() => {
    if (typeof indexedDB === 'undefined') return
    let live = true
    readSyncState(offlineDb()).then(
      (state) => {
        if (live) setCached(state?.repos ?? [])
      },
      () => {
        // Unreadable cache: cards say Pinned instead of Cached.
      },
    )
    return () => {
      live = false
    }
  }, [pins])
  return cached
}

/** Cached: pinned and in the offline copy. Pinned: waiting for the next offline sync. */
export function pinStateOf(name: string, pins: readonly string[], cached: readonly string[] | null): PinState {
  if (!pins.includes(name)) return 'online'
  return cached?.includes(name) === true ? 'cached' : 'pinned'
}

import { useSyncExternalStore } from 'react'
import { ApiError } from '../api/client'
import { runSyncNow, type RunSyncNowOptions } from '../api/status'

/**
 * One Sync now at a time for the whole app (R18): the sidebar card and
 * Sources "Sync all" share this state, so pressing either while a run is on
 * shows the same progress and never starts a second run from this device.
 */

export type SyncNowState =
  | { phase: 'idle' }
  /** Waiting for the server's scan and fetch. */
  | { phase: 'server' }
  /** Pulling this device's offline copy. */
  | { phase: 'device' }
  | { phase: 'done'; at: string; serverFinished: boolean }
  | { phase: 'error'; message: string }

let state: SyncNowState = { phase: 'idle' }
const listeners = new Set<() => void>()

function set(next: SyncNowState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const isSyncing = (current: SyncNowState): boolean => current.phase === 'server' || current.phase === 'device'

/** The progress line under a Sync now button (sidebar card, Pinned "Update all now"); null when idle. */
export function syncProgressText(sync: SyncNowState): string | null {
  switch (sync.phase) {
    case 'server':
      return 'Syncing the server…'
    case 'device':
      return 'Updating this device…'
    case 'done':
      return sync.serverFinished ? 'Up to date.' : 'The server is still syncing; this device has what is ready.'
    case 'error':
      return sync.message
    case 'idle':
      return null
  }
}

export function syncNowErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (error instanceof ApiError && error.status === 404) return 'Sync now isn’t available on this server yet.'
  return 'Sync now failed. Try again.'
}

/**
 * Starts Sync now unless one is running. Resolves when it is over; never
 * rejects (the outcome is in the shared state). `options` is for tests.
 */
export async function startSyncNow(options: Omit<RunSyncNowOptions, 'onPhase'> = {}): Promise<void> {
  if (isSyncing(state)) return
  set({ phase: 'server' })
  try {
    const result = await runSyncNow({ ...options, onPhase: (phase) => set({ phase }) })
    set({ phase: 'done', at: new Date().toISOString(), serverFinished: result.serverFinished })
  } catch (error) {
    set({ phase: 'error', message: syncNowErrorMessage(error) })
  }
}

export function useSyncNow(): SyncNowState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
}

/** Back to idle; for tests only. */
export function resetSyncNow(): void {
  set({ phase: 'idle' })
}

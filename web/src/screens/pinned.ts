import type { CacheBreakdown } from '../offline/storage'

// Helpers for the Pinned and offline page (T45, R11).

/**
 * - `cached`: the last finished sync covered the repo, so its files are on this device.
 * - `waiting`: pinned since the last sync; the next one downloads its files.
 * - `unavailable`: this browser cannot keep an offline copy (no IndexedDB).
 */
export type PinnedRepoState = 'cached' | 'waiting' | 'unavailable'

export function pinnedRepoState(name: string, breakdown: CacheBreakdown | null): PinnedRepoState {
  if (breakdown === null) return 'unavailable'
  return breakdown.syncedAt !== null && breakdown.syncedRepos.includes(name) ? 'cached' : 'waiting'
}

export const CLEAR_DONE_MESSAGE =
  'Offline cache cleared. Pins are kept; the next sync downloads notes and pinned repo files again.'
export const CLEAR_FAILED_MESSAGE = 'Couldn’t clear the offline cache. Try again.'
export const PERSIST_REFUSED_MESSAGE =
  'The browser said no. On iPhone and iPad, add Pythia to the Home Screen and open it from there.'

import { useSyncExternalStore } from 'react'

/**
 * Pinned repos (R11), stored on this device only in `localStorage` under
 * `PINS_KEY` as a sorted JSON array of repo names. T21 passes them to
 * `syncOnce` so pinned repo files are cached for offline search.
 */

export const PINS_KEY = 'pythia.pinnedRepos'

const listeners = new Set<() => void>()
let cachedRaw: string | null | undefined
let cachedPins: readonly string[] = []

function parse(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) {
      return [...new Set(value.filter((name): name is string => typeof name === 'string' && name !== ''))].sort()
    }
  } catch {
    // Unreadable value: treat as no pins.
  }
  return []
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(PINS_KEY)
  } catch {
    // Storage blocked (private mode, disabled cookies).
    return null
  }
}

/** The pinned repo names, sorted. The same array is returned until the stored value changes. */
export function readPinnedRepos(): readonly string[] {
  const raw = readRaw()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedPins = parse(raw)
  }
  return cachedPins
}

/** Pins or unpins a repo. Returns false when the browser refused to store it. */
export function setRepoPinned(name: string, pinned: boolean): boolean {
  const current = readPinnedRepos()
  const next = pinned ? [...new Set([...current, name])].sort() : current.filter((pin) => pin !== name)
  let saved = true
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(next))
  } catch {
    saved = false
  }
  for (const listener of listeners) listener()
  return saved
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab of the app changed the pins.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key === PINS_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePinnedRepos(): readonly string[] {
  return useSyncExternalStore(subscribe, readPinnedRepos, readPinnedRepos)
}

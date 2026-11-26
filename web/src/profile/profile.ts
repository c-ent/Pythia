import { useSyncExternalStore } from 'react'
import { DEFAULT_PROFILE, fetchProfile, isProfile, putProfile, type Profile } from '../api/profile'
import { readThemeChoice, setThemeChoice } from '../theme/theme'

/**
 * The profile (R17) as last seen from the server, cached on this device so the
 * name, opening mode and previews still apply offline and before it loads.
 * The server copy wins whenever it loads, theme included.
 */
export const PROFILE_KEY = 'pythia.profile'

let lastRaw: string | null | undefined
let lastValue: Profile = DEFAULT_PROFILE
// Used when localStorage refuses writes (private mode, storage full).
let unsaved: Profile | null = null
const listeners = new Set<() => void>()

function readRaw(): string | null {
  try {
    return localStorage.getItem(PROFILE_KEY)
  } catch {
    return null
  }
}

/** The cached profile, or the defaults. Returns the same object until it changes. */
export function readProfile(): Profile {
  if (unsaved !== null) return unsaved
  const raw = readRaw()
  if (raw === lastRaw) return lastValue
  lastRaw = raw
  let parsed: unknown = null
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  lastValue = isProfile(parsed) ? parsed : DEFAULT_PROFILE
  return lastValue
}

function notify(): void {
  for (const listener of listeners) listener()
}

function keep(profile: Profile): Profile {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
    unsaved = null
  } catch {
    unsaved = profile
  }
  if (readThemeChoice() !== profile.theme) setThemeChoice(profile.theme)
  notify()
  return profile
}

/** Reads the profile from the server and caches it. Throws `ApiError` on failure. */
export async function loadProfile(signal?: AbortSignal): Promise<Profile> {
  return keep(await fetchProfile(signal))
}

/** Saves the whole profile on the server and caches what it returns. */
export async function saveProfile(profile: Profile): Promise<Profile> {
  return keep(await putProfile(profile))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // A profile saved in another tab.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === PROFILE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The cached profile, re-rendering when it loads or changes. */
export function useProfile(): Profile {
  return useSyncExternalStore(subscribe, readProfile, () => DEFAULT_PROFILE)
}

/** The IANA name as this browser spells it, or null when it does not know the zone (same rule as the server). */
export function canonicalTimeZone(name: string): string | null {
  if (name === '' || name.length > 64) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/** Every zone the browser knows, for the time zone suggestions; empty on old browsers. */
export function timeZoneNames(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

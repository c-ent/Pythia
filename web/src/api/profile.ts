import { ApiError, apiFetch } from './client'

// Mirrors `GET` / `PUT /api/profile` (server/src/routes/profile.ts).

export type ThemeSetting = 'light' | 'dark' | 'system'
export type OpeningMode = 'search' | 'ask'

export interface Profile {
  displayName: string
  timeZone: string
  vaultName: string
  theme: ThemeSetting
  openingMode: OpeningMode
  notePreviews: boolean
}

/** What a fresh install shows (same as the server's `DEFAULT_PROFILE`). */
export const DEFAULT_PROFILE: Readonly<Profile> = Object.freeze({
  displayName: '',
  timeZone: 'Asia/Taipei',
  vaultName: '',
  theme: 'system',
  openingMode: 'search',
  notePreviews: true,
})

export const MAX_DISPLAY_NAME = 80
export const MAX_VAULT_NAME = 200

export function isProfile(value: unknown): value is Profile {
  if (value === null || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.displayName === 'string' &&
    typeof p.timeZone === 'string' &&
    typeof p.vaultName === 'string' &&
    (p.theme === 'light' || p.theme === 'dark' || p.theme === 'system') &&
    (p.openingMode === 'search' || p.openingMode === 'ask') &&
    typeof p.notePreviews === 'boolean'
  )
}

async function readProfile(res: Response): Promise<Profile> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Not JSON; refused below.
  }
  const profile = body !== null && typeof body === 'object' && 'profile' in body ? body.profile : undefined
  if (!isProfile(profile)) throw new ApiError(500, 'bad_response', 'Unexpected profile response')
  return profile
}

export async function fetchProfile(signal?: AbortSignal): Promise<Profile> {
  return readProfile(await apiFetch('/api/profile', { signal }))
}

/** Saves the whole profile and returns it as the server keeps it (trimmed, time zone spelled the standard way). */
export async function putProfile(profile: Profile): Promise<Profile> {
  const res = await apiFetch('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(profile),
  })
  return readProfile(res)
}

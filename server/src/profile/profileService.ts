import { z } from 'zod'

/** Profile and preferences (R17). One per install, shared by every device. */
export interface Profile {
  displayName: string
  timeZone: string
  vaultName: string
  theme: 'light' | 'dark' | 'system'
  openingMode: 'search' | 'ask'
  notePreviews: boolean
}

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

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/**
 * The IANA name as the runtime spells it (`asia/taipei` becomes `Asia/Taipei`),
 * or null when the runtime does not know the zone.
 */
export function canonicalTimeZone(name: string): string | null {
  if (name === '' || name.length > 64) return null
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

const text = (max: number, what: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= max, `${what} must be at most ${max} characters`)
    .refine((value) => !CONTROL_CHARACTER.test(value), `${what} must not contain control characters`)

/** Body of `PUT /api/profile`: the whole profile, replacing the stored one. */
export const profileInputSchema = z.object({
  displayName: text(MAX_DISPLAY_NAME, 'displayName'),
  timeZone: z.string().transform((value, ctx) => {
    const zone = canonicalTimeZone(value.trim())
    if (zone === null) {
      ctx.addIssue({ code: 'custom', message: 'timeZone must be an IANA time zone name, like Asia/Taipei' })
      return z.NEVER
    }
    return zone
  }),
  vaultName: text(MAX_VAULT_NAME, 'vaultName'),
  theme: z.enum(['light', 'dark', 'system']),
  openingMode: z.enum(['search', 'ask']),
  notePreviews: z.boolean(),
})

export interface ProfileStore {
  /** The stored profile, or null when there is none yet. */
  get(): Promise<Profile | null>
  save(profile: Profile): Promise<void>
}

export interface ProfileService {
  getProfile(): Promise<Profile>
  /** Saves the whole profile (validated by `profileInputSchema`) and returns it. */
  setProfile(profile: Profile): Promise<Profile>
}

export function createProfileService(store: ProfileStore): ProfileService {
  return {
    async getProfile() {
      return (await store.get()) ?? { ...DEFAULT_PROFILE }
    },
    async setProfile(profile) {
      const saved = { ...profile }
      await store.save(saved)
      return saved
    },
  }
}

/** For tests and for running without a database. */
export function createMemoryProfileStore(initial: Profile | null = null): ProfileStore {
  let stored = initial === null ? null : { ...initial }
  return {
    async get() {
      return stored === null ? null : { ...stored }
    },
    async save(profile) {
      stored = { ...profile }
    },
  }
}

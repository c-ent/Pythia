import type { Pool } from 'pg'
import type { Profile, ProfileStore } from '../profile/profileService.js'

interface ProfileRow {
  display_name: string
  time_zone: string
  vault_name: string
  theme: Profile['theme']
  opening_mode: Profile['openingMode']
  note_previews: boolean
}

/** The single `profile` row from migrations/004_profile.sql. */
export function createPgProfileStore(pool: Pool): ProfileStore {
  return {
    async get() {
      const { rows } = await pool.query<ProfileRow>(
        'SELECT display_name, time_zone, vault_name, theme, opening_mode, note_previews FROM profile WHERE id = 1',
      )
      const row = rows[0]
      if (row === undefined) return null
      return {
        displayName: row.display_name,
        timeZone: row.time_zone,
        vaultName: row.vault_name,
        theme: row.theme,
        openingMode: row.opening_mode,
        notePreviews: row.note_previews,
      }
    },

    async save(profile) {
      await pool.query(
        `INSERT INTO profile (id, display_name, time_zone, vault_name, theme, opening_mode, note_previews, updated_at)
         VALUES (1, $1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           time_zone = EXCLUDED.time_zone,
           vault_name = EXCLUDED.vault_name,
           theme = EXCLUDED.theme,
           opening_mode = EXCLUDED.opening_mode,
           note_previews = EXCLUDED.note_previews,
           updated_at = now()`,
        [
          profile.displayName,
          profile.timeZone,
          profile.vaultName,
          profile.theme,
          profile.openingMode,
          profile.notePreviews,
        ],
      )
    },
  }
}

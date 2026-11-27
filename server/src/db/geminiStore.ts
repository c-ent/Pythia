import type { Pool } from 'pg'
import type { GeminiKeyStore, GeminiUsageStore, StoredGeminiKey } from '../settings/geminiSettings.js'

interface GeminiKeyRow {
  ciphertext: Buffer
  iv: Buffer
  auth_tag: Buffer
  last4: string
  saved_at: Date
}

/** The single `gemini_key` row from migrations/008_gemini_settings.sql. Only sealed bytes go in. */
export function createPgGeminiKeyStore(pool: Pool): GeminiKeyStore {
  return {
    async get() {
      const { rows } = await pool.query<GeminiKeyRow>(
        'SELECT ciphertext, iv, auth_tag, last4, saved_at FROM gemini_key WHERE id',
      )
      const row = rows[0]
      if (row === undefined) return null
      return {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        last4: row.last4,
        savedAt: row.saved_at,
      } satisfies StoredGeminiKey
    },

    async save(key) {
      await pool.query(
        `INSERT INTO gemini_key (id, ciphertext, iv, auth_tag, last4, saved_at) VALUES (true, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag, last4 = EXCLUDED.last4, saved_at = EXCLUDED.saved_at`,
        [key.ciphertext, key.iv, key.authTag, key.last4, key.savedAt],
      )
    },

    async clear() {
      await pool.query('DELETE FROM gemini_key')
    },
  }
}

/** Requests per Asia/Taipei day in `gemini_usage`. */
export function createPgGeminiUsageStore(pool: Pool): GeminiUsageStore {
  return {
    async increment(day) {
      await pool.query(
        `INSERT INTO gemini_usage (day, requests) VALUES ($1::date, 1)
         ON CONFLICT (day) DO UPDATE SET requests = gemini_usage.requests + 1`,
        [day],
      )
    },

    async get(day) {
      const { rows } = await pool.query<{ requests: number }>('SELECT requests FROM gemini_usage WHERE day = $1::date', [day])
      return rows[0]?.requests ?? 0
    },
  }
}

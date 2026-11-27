import type { Pool } from 'pg'
import type { SessionStore, StoredSession } from '../security/sessionStore.js'

interface SessionRow {
  id: string
  token_hash: string
  password_tag: string
  device_name: string
  user_agent: string
  created_at: Date
  last_seen_at: Date
  expires_at: Date
  revoked_at: Date | null
}

const COLUMNS = 'id, token_hash, password_tag, device_name, user_agent, created_at, last_seen_at, expires_at, revoked_at'

const toStored = (row: SessionRow): StoredSession => ({
  id: Number(row.id),
  tokenHash: row.token_hash,
  passwordTag: row.password_tag,
  deviceName: row.device_name,
  userAgent: row.user_agent,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
})

/** The `sessions` table from migrations/006_sessions.sql. */
export function createPgSessionStore(pool: Pool): SessionStore {
  return {
    async create(session) {
      const { rows } = await pool.query<SessionRow>(
        `INSERT INTO sessions (token_hash, password_tag, device_name, user_agent, created_at, last_seen_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $5, $6)
         RETURNING ${COLUMNS}`,
        [session.tokenHash, session.passwordTag, session.deviceName, session.userAgent, session.createdAt, session.expiresAt],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('session insert returned no row')
      return toStored(row)
    },

    async findByTokenHash(tokenHash) {
      const { rows } = await pool.query<SessionRow>(`SELECT ${COLUMNS} FROM sessions WHERE token_hash = $1`, [tokenHash])
      const row = rows[0]
      return row === undefined ? null : toStored(row)
    },

    async touch(id, at) {
      await pool.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [id, at])
    },

    // "Active" everywhere below: not signed out, not expired, issued under the current password.
    async listActive(passwordTag, now) {
      const { rows } = await pool.query<SessionRow>(
        `SELECT ${COLUMNS} FROM sessions
         WHERE revoked_at IS NULL AND expires_at > $2 AND password_tag = $1
         ORDER BY last_seen_at DESC, id DESC`,
        [passwordTag, now],
      )
      return rows.map(toStored)
    },

    async rename(id, name, passwordTag, now) {
      const { rows } = await pool.query<SessionRow>(
        `UPDATE sessions SET device_name = $2
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > $4 AND password_tag = $3
         RETURNING ${COLUMNS}`,
        [id, name, passwordTag, now],
      )
      const row = rows[0]
      return row === undefined ? null : toStored(row)
    },

    async revoke(id, passwordTag, now) {
      const { rowCount } = await pool.query(
        `UPDATE sessions SET revoked_at = $3
         WHERE id = $1 AND revoked_at IS NULL AND expires_at > $3 AND password_tag = $2`,
        [id, passwordTag, now],
      )
      return (rowCount ?? 0) > 0
    },

    async revokeAll(now) {
      await pool.query('UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL', [now])
    },

    async prune(before) {
      await pool.query('DELETE FROM sessions WHERE revoked_at < $1 OR expires_at < $1', [before])
    },
  }
}

import {
  deviceNameFromUserAgent,
  isSessionToken,
  MAX_USER_AGENT,
  newSessionToken,
  SESSION_MAX_AGE_MS,
  SESSION_RETENTION_MS,
  SESSION_TOUCH_INTERVAL_MS,
  sha256Hex,
} from './session.js'
import { secretsEqual } from './tokens.js'

/** One row of the `sessions` table (migrations/006_sessions.sql). */
export interface StoredSession {
  id: number
  tokenHash: string
  passwordTag: string
  deviceName: string
  userAgent: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  revokedAt: Date | null
}

export interface NewSession {
  tokenHash: string
  passwordTag: string
  deviceName: string
  userAgent: string
  createdAt: Date
  expiresAt: Date
}

/**
 * Storage for web sessions. "Active" means not revoked, not expired at `now`
 * and issued under the current password (`passwordTag`).
 */
export interface SessionStore {
  create(session: NewSession): Promise<StoredSession>
  findByTokenHash(tokenHash: string): Promise<StoredSession | null>
  touch(id: number, at: Date): Promise<void>
  listActive(passwordTag: string, now: Date): Promise<StoredSession[]>
  /** Renames an active session; null when there is none with that id. */
  rename(id: number, name: string, passwordTag: string, now: Date): Promise<StoredSession | null>
  /** Signs out an active session; false when there is none with that id. */
  revoke(id: number, passwordTag: string, now: Date): Promise<boolean>
  /** Signs out every session that is not signed out yet. */
  revokeAll(now: Date): Promise<void>
  /** Deletes sessions that expired or were signed out before `before`. */
  prune(before: Date): Promise<void>
}

/** A signed-in device as the app sees it. */
export interface Session {
  id: number
  deviceName: string
  userAgent: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
}

export interface IssuedSession {
  token: string
  maxAgeMs: number
  session: Session
}

export interface SessionManager {
  issue(userAgent: string | undefined, now?: number): Promise<IssuedSession>
  /** The active session for a cookie value, or null. */
  verify(token: string, now?: number): Promise<Session | null>
  /** Signs out the session of a cookie value (logout); unknown tokens are ignored. */
  revoke(token: string, now?: number): Promise<void>
  list(now?: number): Promise<Session[]>
  rename(id: number, name: string, now?: number): Promise<Session | null>
  revokeDevice(id: number, now?: number): Promise<boolean>
  revokeAll(now?: number): Promise<void>
}

export interface SessionManagerOptions {
  store: SessionStore
  /** The configured password hash; changing the password ends every session. */
  passwordHash: string
  maxAgeMs?: number
  touchIntervalMs?: number
  retentionMs?: number
}

const toSession = (row: StoredSession): Session => ({
  id: row.id,
  deviceName: row.deviceName,
  userAgent: row.userAgent,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
  expiresAt: row.expiresAt,
})

/**
 * Server-side sessions (R15, T36): the cookie holds a random token, the table
 * its hash, so signing a device out lasts across restarts.
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const { store } = options
  const maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS
  const touchIntervalMs = options.touchIntervalMs ?? SESSION_TOUCH_INTERVAL_MS
  const retentionMs = options.retentionMs ?? SESSION_RETENTION_MS
  const passwordTag = sha256Hex(options.passwordHash)

  const active = (row: StoredSession | null, now: number): row is StoredSession =>
    row !== null && row.revokedAt === null && row.expiresAt.getTime() > now && secretsEqual(row.passwordTag, passwordTag)

  const find = async (token: string, now: number): Promise<StoredSession | null> => {
    if (!isSessionToken(token)) return null
    const row = await store.findByTokenHash(sha256Hex(token))
    return active(row, now) ? row : null
  }

  return {
    async issue(userAgent, now = Date.now()) {
      // Logging in is rare, so it is a good moment to drop long-ended sessions.
      await store.prune(new Date(now - retentionMs))
      const token = newSessionToken()
      const row = await store.create({
        tokenHash: sha256Hex(token),
        passwordTag,
        deviceName: deviceNameFromUserAgent(userAgent),
        userAgent: (userAgent ?? '').slice(0, MAX_USER_AGENT),
        createdAt: new Date(now),
        expiresAt: new Date(now + maxAgeMs),
      })
      return { token, maxAgeMs, session: toSession(row) }
    },

    async verify(token, now = Date.now()) {
      const row = await find(token, now)
      if (row === null) return null
      if (now - row.lastSeenAt.getTime() < touchIntervalMs) return toSession(row)
      const lastSeenAt = new Date(now)
      await store.touch(row.id, lastSeenAt)
      return toSession({ ...row, lastSeenAt })
    },

    async revoke(token, now = Date.now()) {
      const row = await find(token, now)
      if (row !== null) await store.revoke(row.id, passwordTag, new Date(now))
    },

    async list(now = Date.now()) {
      return (await store.listActive(passwordTag, new Date(now))).map(toSession)
    },

    async rename(id, name, now = Date.now()) {
      const row = await store.rename(id, name, passwordTag, new Date(now))
      return row === null ? null : toSession(row)
    },

    revokeDevice(id, now = Date.now()) {
      return store.revoke(id, passwordTag, new Date(now))
    },

    revokeAll(now = Date.now()) {
      return store.revokeAll(new Date(now))
    },
  }
}

export interface MemorySessionStore extends SessionStore {
  /** Copies of every row, for tests. */
  rows(): StoredSession[]
}

/** In-memory `SessionStore` for tests; same rules as the Postgres one. */
export function createMemorySessionStore(): MemorySessionStore {
  const rows: StoredSession[] = []
  let nextId = 1
  const copy = (row: StoredSession): StoredSession => ({ ...row })
  const isActive = (row: StoredSession, passwordTag: string, now: Date): boolean =>
    row.revokedAt === null && row.expiresAt > now && row.passwordTag === passwordTag
  const findActive = (id: number, passwordTag: string, now: Date): StoredSession | undefined =>
    rows.find((row) => row.id === id && isActive(row, passwordTag, now))

  return {
    async create(session) {
      if (rows.some((row) => row.tokenHash === session.tokenHash)) throw new Error('duplicate token hash')
      const row: StoredSession = { ...session, id: nextId++, lastSeenAt: session.createdAt, revokedAt: null }
      rows.push(row)
      return copy(row)
    },
    async findByTokenHash(tokenHash) {
      const row = rows.find((candidate) => candidate.tokenHash === tokenHash)
      return row === undefined ? null : copy(row)
    },
    async touch(id, at) {
      const row = rows.find((candidate) => candidate.id === id)
      if (row !== undefined) row.lastSeenAt = at
    },
    async listActive(passwordTag, now) {
      return rows
        .filter((row) => isActive(row, passwordTag, now))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || b.id - a.id)
        .map(copy)
    },
    async rename(id, name, passwordTag, now) {
      const row = findActive(id, passwordTag, now)
      if (row === undefined) return null
      row.deviceName = name
      return copy(row)
    },
    async revoke(id, passwordTag, now) {
      const row = findActive(id, passwordTag, now)
      if (row === undefined) return false
      row.revokedAt = now
      return true
    },
    async revokeAll(now) {
      for (const row of rows) if (row.revokedAt === null) row.revokedAt = now
    },
    async prune(before) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (row !== undefined && ((row.revokedAt !== null && row.revokedAt < before) || row.expiresAt < before)) rows.splice(i, 1)
      }
    },
    rows() {
      return rows.map(copy)
    },
  }
}

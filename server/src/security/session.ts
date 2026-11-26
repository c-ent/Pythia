import { createHmac, randomBytes } from 'node:crypto'
import { secretsEqual } from './tokens.js'

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface SessionSigner {
  issue(now?: number): { token: string; maxAgeMs: number }
  verify(token: string, now?: number): boolean
  /** Ends one session before it expires. Kept in memory, so a restart forgets it. */
  revoke(token: string, now?: number): void
}

export interface SessionOptions {
  secret: string
  /** The configured password hash; changing the password ends every session. */
  passwordHash: string
  maxAgeMs?: number
}

// `<expires ms>.<16-byte nonce>.<HMAC-SHA256>`, base64url parts.
const TOKEN = /^(\d{1,16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/

/**
 * Stateless signed session tokens for the single user, so sessions survive a
 * restart without a sessions table. Rotating `PYTHIA_SESSION_SECRET` or the
 * password ends all of them.
 */
export function createSessionSigner(options: SessionOptions): SessionSigner {
  const maxAgeMs = options.maxAgeMs ?? SESSION_MAX_AGE_MS
  const key = createHmac('sha256', options.secret).update('pythia-session-v1\0').update(options.passwordHash).digest()
  const sign = (payload: string): string => createHmac('sha256', key).update(payload).digest('base64url')
  const revoked = new Map<string, number>()

  const parse = (token: string, now: number): { nonce: string; expires: number } | null => {
    const match = TOKEN.exec(token)
    if (match === null) return null
    const [, expiresText = '', nonce = '', signature = ''] = match
    const expires = Number(expiresText)
    if (!(expires > now && expires <= now + maxAgeMs)) return null
    if (!secretsEqual(signature, sign(`${expiresText}.${nonce}`))) return null
    if (revoked.has(nonce)) return null
    return { nonce, expires }
  }

  return {
    issue(now = Date.now()) {
      const payload = `${now + maxAgeMs}.${randomBytes(16).toString('base64url')}`
      return { token: `${payload}.${sign(payload)}`, maxAgeMs }
    },
    verify(token, now = Date.now()) {
      return parse(token, now) !== null
    },
    revoke(token, now = Date.now()) {
      const session = parse(token, now)
      if (session === null) return
      for (const [nonce, expires] of revoked) if (expires <= now) revoked.delete(nonce)
      revoked.set(session.nonce, session.expires)
    },
  }
}

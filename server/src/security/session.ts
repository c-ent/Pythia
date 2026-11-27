import { createHash } from 'node:crypto'
import { randomSecret } from './tokens.js'

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** `last_seen_at` is written at most this often per session. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000
/** Expired or signed-out sessions are deleted this long after they end. */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_DEVICE_NAME = 80
export const MAX_USER_AGENT = 500
export const UNKNOWN_DEVICE = 'Unknown device'

// 32 random bytes, base64url.
const TOKEN = /^[A-Za-z0-9_-]{43}$/

/** A new session cookie value: 32 random bytes. Only its hash is stored. */
export function newSessionToken(): string {
  return randomSecret(32)
}

/** False for anything that cannot be a token, so junk never reaches the database. */
export function isSessionToken(value: string): boolean {
  return TOKEN.test(value)
}

/** SHA-256, hex. The sessions table keeps this of the token and of the password hash, never the values. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// First match wins: iPhone user agents also say "Mac OS X", Android ones "Linux".
const PLATFORMS: [RegExp, string][] = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
]

// Edge, Opera and Samsung Internet also say "Chrome", and Chrome also says "Safari".
const BROWSERS: [RegExp, string][] = [
  [/EdgiOS|EdgA\/|Edg\//, 'Edge'],
  [/OPR\/|OPiOS/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** A readable default name for a signed-in device, e.g. "iPhone · Safari". */
export function deviceNameFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? ''
  const platform = PLATFORMS.find(([pattern]) => pattern.test(ua))?.[1]
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
  if (platform !== undefined && browser !== undefined) return `${platform} · ${browser}`
  return platform ?? browser ?? UNKNOWN_DEVICE
}

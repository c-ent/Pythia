import { isIP } from 'node:net'

export type TakeResult = { allowed: true } | { allowed: false; retryAfterSeconds: number }

export interface VisitorLimiter {
  /** Records an attempt for `visitor`, or says how long that visitor must wait. */
  take(visitor: string, now?: number): TakeResult
  /** Clears one visitor's window, e.g. after that visitor logs in. */
  reset(visitor: string): void
}

/** Shared bucket for requests whose visitor address is missing or unreadable. */
export const UNKNOWN_VISITOR = 'unknown'
/** Shared bucket for new visitors once `maxVisitors` windows are in use. */
export const OVERFLOW_VISITOR = 'overflow'

export interface VisitorLimiterOptions {
  max: number
  windowMs: number
  /** Cap on tracked visitors, so a flood of addresses cannot exhaust memory. */
  maxVisitors?: number
}

/**
 * Sliding-window limit on attempts, counted per visitor so that failed guesses
 * from one address cannot lock out another. Once `maxVisitors` visitors have
 * attempts in their window, further new visitors share one overflow window.
 */
export function createVisitorLimiter(options: VisitorLimiterOptions): VisitorLimiter {
  const maxVisitors = options.maxVisitors ?? 10_000
  const windows = new Map<string, number[]>()
  const live = (attempts: number[], now: number): number[] => attempts.filter((at) => at > now - options.windowMs)

  const sweep = (now: number): void => {
    for (const [visitor, attempts] of windows) {
      if (live(attempts, now).length === 0) windows.delete(visitor)
    }
  }

  const keyFor = (visitor: string, now: number): string => {
    if (windows.has(visitor) || windows.size < maxVisitors) return visitor
    sweep(now)
    return windows.size < maxVisitors ? visitor : OVERFLOW_VISITOR
  }

  return {
    take(visitor, now = Date.now()) {
      const key = keyFor(visitor, now)
      const attempts = live(windows.get(key) ?? [], now)
      if (attempts.length >= options.max) {
        windows.set(key, attempts)
        const oldest = attempts[0] ?? now
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000)) }
      }
      attempts.push(now)
      windows.set(key, attempts)
      return { allowed: true }
    },
    reset(visitor) {
      windows.delete(visitor)
    },
  }
}

/**
 * The rate-limit key for a request, from its `X-Forwarded-For` header.
 *
 * The server listens on 127.0.0.1 only, so every request comes through
 * Tailscale Serve/Funnel on the host (or from the host itself). Its HTTP
 * proxy sets, not appends, `X-Forwarded-For` to the connecting client's
 * address (for Funnel, the public visitor's), so a copy sent by the visitor
 * is overwritten. See `addProxyForwardedHeaders` in tailscale
 * `ipn/ipnlocal/serve.go`.
 *
 * Anything other than exactly one IP address (missing, empty, a list, junk)
 * maps to one shared bucket, so an odd header cannot open a fresh window.
 * IPv6 addresses are keyed by their /64, since one visitor usually holds a
 * whole /64; IPv4-mapped IPv6 addresses count as the IPv4 address.
 */
export function visitorKey(forwardedFor: string | string[] | undefined): string {
  if (typeof forwardedFor !== 'string') return UNKNOWN_VISITOR
  const address = forwardedFor.trim()
  const version = isIP(address)
  if (version === 4) return address
  if (version === 6) return ipv6Key(address) ?? UNKNOWN_VISITOR
  return UNKNOWN_VISITOR
}

function ipv6Key(address: string): string | null {
  const groups = ipv6Groups(address)
  if (groups === null) return null
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

/** The eight 16-bit groups of an address `isIP` already accepted as IPv6. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // A dotted IPv4 tail (e.g. ::ffff:1.2.3.4) becomes two hex groups.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number)
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const halves = text.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0
  const groups = [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right].map((group) => parseInt(group, 16))
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null
}

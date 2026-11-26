import { describe, expect, it } from 'vitest'
import { createVisitorLimiter, OVERFLOW_VISITOR, UNKNOWN_VISITOR, visitorKey } from './rateLimit.js'

describe('visitor limiter', () => {
  it('blocks after max attempts until the window slides', () => {
    const limiter = createVisitorLimiter({ max: 3, windowMs: 60_000 })
    expect(limiter.take('a', 0).allowed).toBe(true)
    expect(limiter.take('a', 10_000).allowed).toBe(true)
    expect(limiter.take('a', 20_000).allowed).toBe(true)
    expect(limiter.take('a', 30_000)).toEqual({ allowed: false, retryAfterSeconds: 30 })
    expect(limiter.take('a', 60_001).allowed).toBe(true)
    expect(limiter.take('a', 60_002).allowed).toBe(false)
  })

  it('counts each visitor separately', () => {
    const limiter = createVisitorLimiter({ max: 2, windowMs: 60_000 })
    expect(limiter.take('a', 0).allowed).toBe(true)
    expect(limiter.take('a', 1).allowed).toBe(true)
    expect(limiter.take('a', 2).allowed).toBe(false)
    expect(limiter.take('b', 3).allowed).toBe(true)
    expect(limiter.take('b', 4).allowed).toBe(true)
    expect(limiter.take('b', 5).allowed).toBe(false)
  })

  it('reset clears only that visitor', () => {
    const limiter = createVisitorLimiter({ max: 1, windowMs: 60_000 })
    expect(limiter.take('a', 0).allowed).toBe(true)
    expect(limiter.take('b', 0).allowed).toBe(true)
    limiter.reset('a')
    expect(limiter.take('a', 1).allowed).toBe(true)
    expect(limiter.take('b', 1).allowed).toBe(false)
  })

  it('sends new visitors to one shared window once maxVisitors are tracked', () => {
    const limiter = createVisitorLimiter({ max: 1, windowMs: 60_000, maxVisitors: 2 })
    expect(limiter.take('a', 0).allowed).toBe(true)
    expect(limiter.take('b', 0).allowed).toBe(true)
    expect(limiter.take('c', 0).allowed).toBe(true)
    expect(limiter.take('d', 0).allowed).toBe(false)
    expect(limiter.take(OVERFLOW_VISITOR, 0).allowed).toBe(false)
    // Expired windows are dropped, so a new visitor gets its own window again.
    expect(limiter.take('e', 60_001).allowed).toBe(true)
    expect(limiter.take('e', 60_002).allowed).toBe(false)
    expect(limiter.take('f', 60_002).allowed).toBe(true)
  })
})

describe('visitorKey', () => {
  it('uses a single IPv4 address as is', () => {
    expect(visitorKey('203.0.113.7')).toBe('203.0.113.7')
    expect(visitorKey(' 203.0.113.7 ')).toBe('203.0.113.7')
  })

  it('maps a missing, empty, list or junk value to the shared unknown bucket', () => {
    for (const value of [undefined, '', '   ', 'not-an-ip', '203.0.113.7, 198.51.100.20', '203.0.113.7:443', '999.1.1.1']) {
      expect(visitorKey(value)).toBe(UNKNOWN_VISITOR)
    }
    expect(visitorKey(['203.0.113.7'])).toBe(UNKNOWN_VISITOR)
  })

  it('keys IPv6 addresses by their /64', () => {
    expect(visitorKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(visitorKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64')
    expect(visitorKey('2001:DB8:0001:0002:ffff::')).toBe('2001:db8:1:2::/64')
    expect(visitorKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(visitorKey('2001:db8:1:3::1')).not.toBe(visitorKey('2001:db8:1:2::1'))
    expect(visitorKey('::1')).toBe('0:0:0:0::/64')
  })

  it('treats an IPv4-mapped IPv6 address as the IPv4 address', () => {
    expect(visitorKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(visitorKey('::ffff:cb00:7107')).toBe('203.0.113.7')
  })
})

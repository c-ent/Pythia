import { describe, expect, it } from 'vitest'
import { deviceNameFromUserAgent, isSessionToken, newSessionToken, sha256Hex, UNKNOWN_DEVICE } from './session.js'
import { randomSecret, secretsEqual } from './tokens.js'

describe('secretsEqual', () => {
  it('matches only identical strings, of any length', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true)
    expect(secretsEqual('abc', 'abd')).toBe(false)
    expect(secretsEqual('abc', 'abcd')).toBe(false)
    expect(secretsEqual('', 'abc')).toBe(false)
  })

  it('generates distinct URL-safe secrets', () => {
    const a = randomSecret()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomSecret()).not.toBe(a)
  })
})

describe('session tokens', () => {
  it('are 32 random bytes that pass the shape check', () => {
    const token = newSessionToken()
    expect(isSessionToken(token)).toBe(true)
    expect(newSessionToken()).not.toBe(token)
  })

  it('reject anything else before it reaches the database', () => {
    for (const bad of ['', 'x', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}.`, `1.${'A'.repeat(22)}.${'A'.repeat(43)}`]) {
      expect(isSessionToken(bad)).toBe(false)
    }
  })

  it('hash to hex SHA-256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('deviceNameFromUserAgent', () => {
  const cases: [string, string][] = [
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
      'iPhone · Safari',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1',
      'iPad · Safari',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      'Mac · Chrome',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      'Windows · Edge',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0', 'Windows · Firefox'],
    [
      'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
      'Android · Chrome',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1',
      'iPhone · Chrome',
    ],
    ['curl/8.11.0', UNKNOWN_DEVICE],
    ['', UNKNOWN_DEVICE],
  ]

  it.each(cases)('names %s', (userAgent, name) => {
    expect(deviceNameFromUserAgent(userAgent)).toBe(name)
  })

  it('names a missing user agent', () => {
    expect(deviceNameFromUserAgent(undefined)).toBe(UNKNOWN_DEVICE)
  })
})

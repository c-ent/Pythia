import { describe, expect, it } from 'vitest'
import { createSessionSigner } from './session.js'
import { randomSecret, secretsEqual } from './tokens.js'

const secret = 's'.repeat(40)
const passwordHash = '$argon2id$' + 'v=19$m=1024,t=2,p=1$c2FsdA$a2V5'
const now = Date.UTC(2026, 10, 25)
const day = 24 * 60 * 60 * 1000

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

describe('session signer', () => {
  const signer = createSessionSigner({ secret, passwordHash, maxAgeMs: 30 * day })

  it('verifies a token it issued until it expires', () => {
    const { token, maxAgeMs } = signer.issue(now)
    expect(maxAgeMs).toBe(30 * day)
    expect(signer.verify(token, now)).toBe(true)
    expect(signer.verify(token, now + 29 * day)).toBe(true)
    expect(signer.verify(token, now + 30 * day)).toBe(false)
  })

  it('rejects tampered and malformed tokens', () => {
    const { token } = signer.issue(now)
    const [expires = '', nonce = '', signature = ''] = token.split('.')
    const flip = (text: string): string => (text.startsWith('A') ? 'B' : 'A') + text.slice(1)
    expect(signer.verify(`${expires}.${nonce}.${flip(signature)}`, now)).toBe(false)
    expect(signer.verify(`${expires}.${flip(nonce)}.${signature}`, now)).toBe(false)
    expect(signer.verify(`${Number(expires) + 1}.${nonce}.${signature}`, now)).toBe(false)
    for (const bad of ['', 'x', `${token}.x`, token.replaceAll('.', ':')]) expect(signer.verify(bad, now)).toBe(false)
  })

  it('rejects tokens from another secret or password', () => {
    const { token } = signer.issue(now)
    expect(createSessionSigner({ secret: 't'.repeat(40), passwordHash }).verify(token, now)).toBe(false)
    expect(createSessionSigner({ secret, passwordHash: passwordHash + 'x' }).verify(token, now)).toBe(false)
    expect(createSessionSigner({ secret, passwordHash }).verify(token, now)).toBe(true)
  })

  it('rejects an expiry further out than the maximum age', () => {
    const longer = createSessionSigner({ secret, passwordHash, maxAgeMs: 60 * day })
    expect(signer.verify(longer.issue(now).token, now)).toBe(false)
  })

  it('ends a revoked session only', () => {
    const a = signer.issue(now).token
    const b = signer.issue(now).token
    signer.revoke(a, now)
    expect(signer.verify(a, now)).toBe(false)
    expect(signer.verify(b, now)).toBe(true)
    signer.revoke('garbage', now)
  })
})

import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateSecretsKey, openSecret, parseSecretsKey, sealSecret, SECRETS_KEY_BYTES } from './secretBox.js'

// Built by concatenation so no key-like literal is committed.
const plain = 'AIza' + 'q'.repeat(31) + 'W9xz'
const CONTEXT = 'test:secret'

describe('secret box', () => {
  const key = randomBytes(SECRETS_KEY_BYTES)

  it('opens what it sealed, and the sealed bytes hold no plain text', () => {
    const sealed = sealSecret(key, plain, CONTEXT)
    expect(openSecret(key, sealed, CONTEXT)).toBe(plain)
    for (const part of [sealed.ciphertext, sealed.iv, sealed.authTag]) {
      expect(part.toString('utf8')).not.toContain(plain)
      expect(part.toString('latin1')).not.toContain('AIza')
    }
    expect(sealed.iv).toHaveLength(12)
    expect(sealed.authTag).toHaveLength(16)
  })

  it('uses a fresh IV every time', () => {
    const a = sealSecret(key, plain, CONTEXT)
    const b = sealSecret(key, plain, CONTEXT)
    expect(a.iv.equals(b.iv)).toBe(false)
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
  })

  it('returns null for a wrong key, another context or changed bytes', () => {
    const sealed = sealSecret(key, plain, CONTEXT)
    expect(openSecret(randomBytes(SECRETS_KEY_BYTES), sealed, CONTEXT)).toBeNull()
    expect(openSecret(key, sealed, 'other:secret')).toBeNull()
    const flipped = Buffer.from(sealed.ciphertext)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(openSecret(key, { ...sealed, ciphertext: flipped }, CONTEXT)).toBeNull()
    expect(openSecret(key, { ...sealed, authTag: Buffer.alloc(16) }, CONTEXT)).toBeNull()
    expect(openSecret(key, { ...sealed, iv: Buffer.alloc(8) }, CONTEXT)).toBeNull()
  })

  it('refuses a key of the wrong length', () => {
    expect(() => sealSecret(Buffer.alloc(16), plain, CONTEXT)).toThrow(RangeError)
  })
})

describe('parseSecretsKey', () => {
  it('reads a generated key, with or without padding, in base64 or base64url', () => {
    const text = generateSecretsKey()
    const key = parseSecretsKey(text)
    expect(key).toHaveLength(SECRETS_KEY_BYTES)
    expect(parseSecretsKey(` ${text} `)?.equals(key!)).toBe(true)
    expect(parseSecretsKey(text.replace(/=$/, ''))?.equals(key!)).toBe(true)
    const url = key!.toString('base64url')
    expect(parseSecretsKey(url)?.equals(key!)).toBe(true)
  })

  it.each([
    [''],
    ['short'],
    ['x'.repeat(64)],
    [randomBytes(16).toString('base64')],
    [randomBytes(48).toString('base64')],
    ['!'.repeat(43)],
  ])('rejects %j', (text) => {
    expect(parseSecretsKey(text)).toBeNull()
  })
})

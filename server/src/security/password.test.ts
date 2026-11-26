import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { hashPassword, parsePasswordHash, verifyPassword, type PasswordHash } from './password.js'

// Cheap cost so the suite stays fast; the default cost has its own test.
const cost = { memory: 1024, passes: 2, parallelism: 1 }
const pw = 'correct ' + 'horse battery'

function parsed(hash: string): PasswordHash {
  const result = parsePasswordHash(hash)
  if (result === null) throw new Error('hash did not parse')
  return result
}

describe('password hashing', () => {
  it('hashes to an argon2id PHC string that verifies only the right password', async () => {
    const hash = await hashPassword(pw, cost)
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(hash).not.toContain(pw)
    const stored = parsed(hash)
    expect(await verifyPassword(pw, stored)).toBe(true)
    expect(await verifyPassword(pw + 'x', stored)).toBe(false)
    expect(await verifyPassword(pw.toUpperCase(), stored)).toBe(false)
    expect(await verifyPassword('', stored)).toBe(false)
  })

  it('uses a fresh salt each time', async () => {
    expect(await hashPassword(pw, cost)).not.toBe(await hashPassword(pw, cost))
  })

  it('verifies with the default cost', async () => {
    const hash = await hashPassword(pw)
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/)
    expect(await verifyPassword(pw, parsed(hash))).toBe(true)
    // Two full-cost argon2id runs (64 MiB, t=3) can pass 5 s when the whole
    // suite runs in parallel on a busy machine.
  }, 30_000)

  it('survives a single-quoted .env line', async () => {
    const hash = await hashPassword(pw, cost)
    expect(parseEnv(`PYTHIA_PASSWORD_HASH='${hash}'\n`).PYTHIA_PASSWORD_HASH).toBe(hash)
  })

  it('rejects malformed hashes and out-of-bounds cost', async () => {
    const hash = await hashPassword(pw, cost)
    const [, , , , salt = '', key = ''] = hash.split('$')
    const variants = [
      '',
      'plain text',
      hash.replace('$argon2id$', '$argon2i$'),
      hash.replace('v=19', 'v=16'),
      hash.replace('m=1024', 'm=1048576'),
      hash.replace('m=1024', 'm=4'),
      hash.replace('t=2', 't=0'),
      hash.replace('t=2', 't=99'),
      hash.replace('p=1', 'p=0'),
      hash.replace('p=1', 'p=64'),
      hash.replace(salt, 'AAAA'),
      hash.replace(key, 'AAAA'),
      `${hash}$extra`,
    ]
    for (const variant of variants) expect(parsePasswordHash(variant), variant).toBeNull()
  })
})

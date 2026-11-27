import { describe, expect, it } from 'vitest'
import { sha256Hex } from './session.js'
import { createMemorySessionStore, createSessionManager } from './sessionStore.js'

const passwordHash = '$argon2id$' + 'v=19$m=1024,t=2,p=1$c2FsdA$a2V5'
const now = Date.UTC(2026, 10, 26)
const minute = 60 * 1000
const day = 24 * 60 * minute
const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1'

function setup() {
  const store = createMemorySessionStore()
  return { store, sessions: createSessionManager({ store, passwordHash }) }
}

describe('session manager', () => {
  it('stores only the hash of the token and of the password hash', async () => {
    const { store, sessions } = setup()
    const { token, maxAgeMs, session } = await sessions.issue(iphone, now)
    expect(maxAgeMs).toBe(30 * day)
    expect(session.deviceName).toBe('iPhone · Safari')
    const [row] = store.rows()
    expect(row?.tokenHash).toBe(sha256Hex(token))
    expect(row?.passwordTag).toBe(sha256Hex(passwordHash))
    expect(JSON.stringify(store.rows())).not.toContain(token)
    expect(JSON.stringify(store.rows())).not.toContain(passwordHash)
    expect(row?.expiresAt.getTime()).toBe(now + 30 * day)
  })

  it('verifies a session until it expires', async () => {
    const { sessions } = setup()
    const { token } = await sessions.issue(iphone, now)
    expect(await sessions.verify(token, now)).not.toBeNull()
    expect(await sessions.verify(token, now + 29 * day)).not.toBeNull()
    expect(await sessions.verify(token, now + 30 * day)).toBeNull()
  })

  it('rejects unknown and malformed tokens', async () => {
    const { sessions } = setup()
    const { token } = await sessions.issue(iphone, now)
    const flipped = (token.startsWith('A') ? 'B' : 'A') + token.slice(1)
    for (const bad of ['', 'x', flipped, `${token}x`]) expect(await sessions.verify(bad, now)).toBeNull()
  })

  it('ends every session when the password changes', async () => {
    const { store, sessions } = setup()
    const { token } = await sessions.issue(iphone, now)
    const changed = createSessionManager({ store, passwordHash: passwordHash + 'x' })
    expect(await changed.verify(token, now)).toBeNull()
    expect(await changed.list(now)).toEqual([])
    expect(await createSessionManager({ store, passwordHash }).verify(token, now)).not.toBeNull()
  })

  it('writes last seen at most once every 5 minutes', async () => {
    const { store, sessions } = setup()
    const { token } = await sessions.issue(iphone, now)
    await sessions.verify(token, now + 4 * minute)
    expect(store.rows()[0]?.lastSeenAt.getTime()).toBe(now)
    const seen = await sessions.verify(token, now + 6 * minute)
    expect(seen?.lastSeenAt.getTime()).toBe(now + 6 * minute)
    expect(store.rows()[0]?.lastSeenAt.getTime()).toBe(now + 6 * minute)
  })

  it('logs out one session by its token and keeps the row', async () => {
    const { store, sessions } = setup()
    const a = await sessions.issue(iphone, now)
    const b = await sessions.issue(undefined, now)
    await sessions.revoke(a.token, now)
    await sessions.revoke('garbage', now)
    expect(await sessions.verify(a.token, now)).toBeNull()
    expect(await sessions.verify(b.token, now)).not.toBeNull()
    expect(store.rows()).toHaveLength(2)
    expect(store.rows()[0]?.revokedAt?.getTime()).toBe(now)
  })

  it('lists, renames and signs out devices by id', async () => {
    const { sessions } = setup()
    const a = await sessions.issue(iphone, now)
    const b = await sessions.issue(undefined, now + minute)
    expect((await sessions.list(now + minute)).map((s) => [s.id, s.deviceName])).toEqual([
      [b.session.id, 'Unknown device'],
      [a.session.id, 'iPhone · Safari'],
    ])
    expect((await sessions.rename(a.session.id, 'Kitchen iPhone', now))?.deviceName).toBe('Kitchen iPhone')
    expect(await sessions.rename(999, 'Nope', now)).toBeNull()
    expect(await sessions.revokeDevice(a.session.id, now)).toBe(true)
    expect(await sessions.revokeDevice(a.session.id, now)).toBe(false)
    expect(await sessions.rename(a.session.id, 'Too late', now)).toBeNull()
    expect(await sessions.verify(a.token, now)).toBeNull()
    expect((await sessions.list(now + minute)).map((s) => s.id)).toEqual([b.session.id])
  })

  it('signs out everywhere', async () => {
    const { sessions } = setup()
    const a = await sessions.issue(iphone, now)
    const b = await sessions.issue(undefined, now)
    await sessions.revokeAll(now)
    expect(await sessions.verify(a.token, now)).toBeNull()
    expect(await sessions.verify(b.token, now)).toBeNull()
    expect(await sessions.list(now)).toEqual([])
    expect(await sessions.verify((await sessions.issue(iphone, now)).token, now)).not.toBeNull()
  })

  it('deletes sessions 30 days after they end, when someone logs in', async () => {
    const { store, sessions } = setup()
    const old = await sessions.issue(iphone, now)
    const revoked = await sessions.issue(iphone, now)
    await sessions.revoke(revoked.token, now + day)
    // `old` expires at now + 30 days; 30 days later it can go, `revoked` went 59 days before that.
    await sessions.issue(iphone, now + 60 * day + 1)
    expect(store.rows().map((row) => row.id)).not.toContain(old.session.id)
    expect(store.rows().map((row) => row.id)).not.toContain(revoked.session.id)
    expect(store.rows()).toHaveLength(1)
  })

  it('keeps long user agents to 500 characters', async () => {
    const { store, sessions } = setup()
    await sessions.issue('x'.repeat(900), now)
    expect(store.rows()[0]?.userAgent).toHaveLength(500)
  })
})

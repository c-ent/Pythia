import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import {
  canonicalTimeZone,
  createMemoryProfileStore,
  createProfileService,
  DEFAULT_PROFILE,
  MAX_DISPLAY_NAME,
  type ProfileStore,
} from '../profile/profileService.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createSessionSigner } from '../security/session.js'
import type { SearchService } from '../search/searchService.js'
import { SESSION_COOKIE, type AuthDeps } from './auth.js'

const sessions = createSessionSigner({ secret: 'r'.repeat(32), passwordHash: 'test-hash' })
const auth: AuthDeps = {
  login: {
    password: { cost: { memory: 1024, passes: 2, parallelism: 1 }, salt: Buffer.alloc(16), key: Buffer.alloc(32) },
    sessions,
    limiter: createVisitorLimiter({ max: 10, windowMs: 60_000 }),
  },
  mcpToken: null,
}
const cookie = `${SESSION_COOKIE}=${sessions.issue().token}`

const search = {} as SearchService
const ask = {} as AskService

const VALID = {
  displayName: 'Cent',
  timeZone: 'Europe/London',
  vaultName: 'Main vault',
  theme: 'dark',
  openingMode: 'ask',
  notePreviews: false,
}

describe('profile routes', () => {
  let server: Server
  let base: string
  let store: ProfileStore

  beforeAll(async () => {
    const app = createApp({
      search,
      ask,
      auth,
      profile: createProfileService({ get: () => store.get(), save: (profile) => store.save(profile) }),
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    store = createMemoryProfileStore()
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const get = (withCookie = true) => fetch(`${base}/api/profile`, { headers: withCookie ? { cookie } : {} })
  const put = (body: unknown, withCookie = true) =>
    fetch(`${base}/api/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('answers the defaults before anything is saved', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ profile: DEFAULT_PROFILE })
    expect(DEFAULT_PROFILE.timeZone).toBe('Asia/Taipei')
  })

  it('saves the whole profile and returns it on the next load', async () => {
    const res = await put(VALID)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ profile: VALID })
    expect(await (await get()).json()).toEqual({ profile: VALID })
  })

  it('trims text, allows an empty name and spells the time zone the standard way', async () => {
    const res = await put({ ...VALID, displayName: '   ', vaultName: '  Notes  ', timeZone: 'asia/taipei' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      profile: { ...VALID, displayName: '', vaultName: 'Notes', timeZone: 'Asia/Taipei' },
    })
  })

  it.each([
    [{ ...VALID, timeZone: 'Mars/Olympus' }, /timeZone/],
    [{ ...VALID, timeZone: '' }, /timeZone/],
    [{ ...VALID, displayName: 'a'.repeat(MAX_DISPLAY_NAME + 1) }, /displayName/],
    [{ ...VALID, displayName: 'a\u0007b' }, /control characters/],
    [{ ...VALID, theme: 'blue' }, /theme/],
    [{ ...VALID, openingMode: 'home' }, /openingMode/],
    [{ ...VALID, notePreviews: 'yes' }, /notePreviews/],
    [{ displayName: 'Cent' }, /timeZone|vaultName|theme/],
  ])('rejects invalid input %# with 400 and keeps the stored profile', async (body, message) => {
    await put(VALID)
    const res = await put(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('invalid_input')
    expect(json.error.message).toMatch(message)
    expect(await (await get()).json()).toEqual({ profile: VALID })
  })

  it('needs a session for reading and saving', async () => {
    expect((await get(false)).status).toBe(401)
    expect((await put(VALID, false)).status).toBe(401)
    expect(await store.get()).toBeNull()
  })
})

describe('canonicalTimeZone', () => {
  it('knows IANA names and refuses the rest', () => {
    expect(canonicalTimeZone('Asia/Taipei')).toBe('Asia/Taipei')
    expect(canonicalTimeZone('UTC')).toBe('UTC')
    expect(canonicalTimeZone('Nowhere/City')).toBeNull()
    expect(canonicalTimeZone('')).toBeNull()
    expect(canonicalTimeZone('A'.repeat(65))).toBeNull()
  })
})

describe('profile routes without a profile service', () => {
  it('answers 404', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      expect((await fetch(`${base}/api/profile`, { headers: { cookie } })).status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

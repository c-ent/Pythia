import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import { createMemoryLlmExclusionStore, type LlmExclusionStore } from '../ingest/llmExclusions.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createSessionSigner } from '../security/session.js'
import type { SearchService } from '../search/searchService.js'
import { createSettingsService, MAX_LLM_EXCLUSIONS } from '../settings/settingsService.js'
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

describe('settings routes: Gemini exclusion list', () => {
  let server: Server
  let base: string
  let store: LlmExclusionStore
  let refreshes = 0

  beforeAll(async () => {
    const app = createApp({
      search,
      ask,
      auth,
      settings: createSettingsService({
        exclusions: { list: () => store.list(), replace: (list) => store.replace(list) },
        refreshAllowLlm: async () => {
          refreshes++
        },
      }),
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    store = createMemoryLlmExclusionStore()
    refreshes = 0
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const get = (withCookie = true) =>
    fetch(`${base}/api/settings/llm-exclusions`, { headers: withCookie ? { cookie } : {} })
  const put = (body: unknown, withCookie = true) =>
    fetch(`${base}/api/settings/llm-exclusions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('starts empty', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ exclusions: [] })
  })

  it('saves a folder and a single note, normalized, deduplicated and sorted', async () => {
    const res = await put({
      exclusions: [
        { kind: 'note', path: 'Journal\\2026\\today.md' },
        { kind: 'folder', path: '/Private/' },
        { kind: 'folder', path: 'private' },
        { kind: 'folder', path: './Work/Secret' },
      ],
    })
    expect(res.status).toBe(200)
    const saved = {
      exclusions: [
        { kind: 'folder', path: 'Private' },
        { kind: 'folder', path: 'Work/Secret' },
        { kind: 'note', path: 'Journal/2026/today.md' },
      ],
    }
    expect(await res.json()).toEqual(saved)
    expect(await (await get()).json()).toEqual(saved)
    expect(refreshes).toBe(1)
  })

  it('removes entries by saving the shorter list', async () => {
    await put({ exclusions: [{ kind: 'folder', path: 'Private' }, { kind: 'note', path: 'a.md' }] })
    await put({ exclusions: [{ kind: 'note', path: 'a.md' }] })
    expect(await (await get()).json()).toEqual({ exclusions: [{ kind: 'note', path: 'a.md' }] })
    await put({ exclusions: [] })
    expect(await (await get()).json()).toEqual({ exclusions: [] })
    expect(refreshes).toBe(3)
  })

  it.each([
    [{ exclusions: [{ kind: 'folder', path: '../outside' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'folder', path: '   ' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'note', path: 'Notes/plan' }] }, /\.md/],
    [{ exclusions: [{ kind: 'tag', path: 'x' }] }, /exclusions\.0\.kind/],
    [{ exclusions: [{ kind: 'folder', path: 'a\u0000b' }] }, /control characters/],
    [{ exclusions: 'Private' }, /exclusions/],
    [{}, /exclusions/],
  ])('rejects invalid input %# with 400 and keeps the stored list', async (body, message) => {
    await put({ exclusions: [{ kind: 'folder', path: 'Keep' }] })
    const res = await put(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('invalid_input')
    expect(json.error.message).toMatch(message)
    expect(await (await get()).json()).toEqual({ exclusions: [{ kind: 'folder', path: 'Keep' }] })
  })

  it('rejects a list longer than the limit', async () => {
    const exclusions = Array.from({ length: MAX_LLM_EXCLUSIONS + 1 }, (_, i) => ({ kind: 'folder', path: `f${i}` }))
    expect((await put({ exclusions })).status).toBe(400)
  })

  it('needs a session for reading and saving', async () => {
    expect((await get(false)).status).toBe(401)
    expect((await put({ exclusions: [] }, false)).status).toBe(401)
    expect(await store.list()).toEqual([])
  })
})

describe('settings routes without a settings service', () => {
  it('answers 404', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const res = await fetch(`${base}/api/settings/llm-exclusions`, { headers: { cookie } })
      expect(res.status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

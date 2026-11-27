import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { hashPassword, parsePasswordHash } from '../security/password.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createMcpTokenService, createMemoryMcpTokenStore } from '../mcp/mcpToken.js'
import { createMemorySessionStore, createSessionManager } from '../security/sessionStore.js'
import type { AskService } from '../ask/askService.js'
import type { SearchService } from '../search/searchService.js'
import { createAuthDeps, SESSION_COOKIE, type AuthDeps } from './auth.js'

const cost = { memory: 1024, passes: 2, parallelism: 1 }
const pw = 'correct ' + 'horse battery'
const mcpToken = 'm'.repeat(20) + 'cp-test-token-value'

const search: SearchService = {
  async search() {
    return { results: [], degraded: false }
  },
  async getDocument() {
    return null
  },
  async findDocument() {
    return null
  },
  async recent() {
    return []
  },
}

const ask: AskService = {
  async ask() {
    return { answer: null, engine: 'retrieval', model: null, fallbacks: ['no_results'], citations: [], withheld: 0, degraded: false }
  },
}

const closers: (() => Promise<void>)[] = []

async function start(auth: AuthDeps): Promise<string> {
  const server = createServer(createApp({ search, ask, auth }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterAll(async () => {
  await Promise.all(closers.map((close) => close()))
})

async function loginDeps(max: number): Promise<AuthDeps> {
  const hash = await hashPassword(pw, cost)
  const password = parsePasswordHash(hash)
  if (password === null) throw new Error('hash did not parse')
  return {
    login: {
      password,
      sessions: createSessionManager({ store: createMemorySessionStore(), passwordHash: hash }),
      limiter: createVisitorLimiter({ max, windowMs: 60_000 }),
    },
    mcp: createMcpTokenService({ envToken: mcpToken, store: createMemoryMcpTokenStore() }),
  }
}

const login = (base: string, body: unknown, forwardedFor?: string) =>
  fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }) },
    body: JSON.stringify(body),
  })

const searchWith = (base: string, cookie?: string) =>
  fetch(`${base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify({ query: 'goals' }),
  })

const cookieFrom = (res: Response): string => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''

describe('auth', () => {
  let base: string

  beforeAll(async () => {
    base = await start(await loginDeps(10))
  })

  it('returns 401 for unauthenticated /api requests', async () => {
    const res = await searchWith(base)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sign in required' } })
    expect((await fetch(`${base}/api/recent`)).status).toBe(401)
    expect((await fetch(`${base}/api/documents/7`)).status).toBe(401)
    expect((await fetch(`${base}/api/session`)).status).toBe(401)
    expect((await fetch(`${base}/api/nope`)).status).toBe(401)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('returns 401 for a forged or unknown session cookie', async () => {
    expect((await searchWith(base, `${SESSION_COOKIE}=1.${'A'.repeat(22)}.${'A'.repeat(43)}`)).status).toBe(401)
    expect((await searchWith(base, `${SESSION_COOKIE}=${'A'.repeat(43)}`)).status).toBe(401)
    expect((await searchWith(base, 'pythia_session=whatever')).status).toBe(401)
  })

  it('rejects a wrong password with 401 and no cookie', async () => {
    const res = await login(base, { password: pw + 'x' })
    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.json()).toEqual({ error: { code: 'invalid_credentials', message: 'Wrong password' } })
  })

  it('returns 400 for a missing password', async () => {
    expect((await login(base, {})).status).toBe(400)
    expect((await login(base, { password: '' })).status).toBe(400)
  })

  it('logs in with a secure session cookie that opens /api', async () => {
    const res = await login(base, { password: pw })
    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`))
    expect(setCookie).toMatch(/; HttpOnly/i)
    expect(setCookie).toMatch(/; Secure/i)
    expect(setCookie).toMatch(/; SameSite=Lax/i)
    expect(setCookie).toMatch(/; Path=\//i)
    expect(setCookie).toMatch(/; Max-Age=2592000/i)

    const cookie = cookieFrom(res)
    expect((await searchWith(base, cookie)).status).toBe(200)
    const session = await fetch(`${base}/api/session`, { headers: { cookie } })
    expect(await session.json()).toEqual({ authenticated: true })
  })

  it('ends the session on logout', async () => {
    const cookie = cookieFrom(await login(base, { password: pw }))
    expect((await searchWith(base, cookie)).status).toBe(200)
    const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
    expect((await searchWith(base, cookie)).status).toBe(401)
  })

  it('returns 401 on /mcp without the right bearer token', async () => {
    const none = await fetch(`${base}/mcp`, { method: 'POST' })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer')
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${mcpToken}x` } })).status).toBe(401)
    expect((await fetch(`${base}/mcp`, { headers: { authorization: mcpToken } })).status).toBe(401)
    // A web session does not open /mcp.
    const cookie = cookieFrom(await login(base, { password: pw }))
    expect((await fetch(`${base}/mcp`, { headers: { cookie } })).status).toBe(401)
    // Past the token check the MCP router answers; it is stateless, so GET is 405.
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${mcpToken}` } })).status).toBe(405)
  })
})

// `/mcp` is tailnet only (R7, T48): the 403 comes before the token check.
describe('tailnet-only /mcp', () => {
  let base: string
  const bearer = { authorization: `Bearer ${mcpToken}` }
  const tailnetOnlyBody = { error: { code: 'tailnet_only', message: '/mcp is only available over Tailscale' } }

  beforeAll(async () => {
    base = await start(await loginDeps(10))
  })

  it('refuses a Funnel request with 403, with or without a valid token', async () => {
    const funnel = { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' }
    const withToken = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...funnel, ...bearer } })
    expect(withToken.status).toBe(403)
    expect(await withToken.json()).toEqual(tailnetOnlyBody)
    expect(withToken.headers.get('www-authenticate')).toBeNull()
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: funnel })).status).toBe(403)
  })

  it('refuses public or unreadable forwarded addresses even without the Funnel header', async () => {
    for (const forwardedFor of ['203.0.113.9', '100.64.0.1, 203.0.113.9', 'junk', '192.168.1.4']) {
      const res = await fetch(`${base}/mcp`, { headers: { 'x-forwarded-for': forwardedFor, ...bearer } })
      expect(res.status, forwardedFor).toBe(403)
    }
    expect((await fetch(`${base}/mcp`, { headers: { 'x-forwarded-proto': 'https', ...bearer } })).status).toBe(403)
  })

  it('lets tailnet and host requests through to the token check', async () => {
    const tailnet = { 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' }
    expect((await fetch(`${base}/mcp`, { headers: { ...tailnet, ...bearer } })).status).toBe(405)
    expect((await fetch(`${base}/mcp`, { headers: tailnet })).status).toBe(401)
    expect((await fetch(`${base}/mcp`, { headers: bearer })).status).toBe(405)
  })

  it('leaves the web app and /api open to Funnel visitors', async () => {
    const funnel = { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' }
    expect((await fetch(`${base}/healthz`, { headers: funnel })).status).toBe(200)
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { ...funnel, 'content-type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    })
    expect(res.status).toBe(204)
  })
})

describe('login rate limit', () => {
  it('returns 429 with Retry-After once the limit is reached, even for the right password', async () => {
    const base = await start(await loginDeps(3))
    for (let i = 0; i < 3; i++) expect((await login(base, { password: `wrong-${i}` })).status).toBe(401)
    const blocked = await login(base, { password: pw })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await blocked.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many login attempts; try again later' },
    })
    expect(blocked.headers.get('set-cookie')).toBeNull()
  })

  it('counts parallel guesses', async () => {
    const base = await start(await loginDeps(3))
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => login(base, { password: `w${i}` }).then((r) => r.status)))
    expect(statuses.filter((s) => s === 401)).toHaveLength(3)
    expect(statuses.filter((s) => s === 429)).toHaveLength(3)
  })

  it('resets after a successful login', async () => {
    const base = await start(await loginDeps(3))
    expect((await login(base, { password: 'wrong-1' })).status).toBe(401)
    expect((await login(base, { password: 'wrong-2' })).status).toBe(401)
    expect((await login(base, { password: pw })).status).toBe(204)
    expect((await login(base, { password: 'wrong-3' })).status).toBe(401)
    expect((await login(base, { password: 'wrong-4' })).status).toBe(401)
  })
})

// Behind Tailscale Funnel, X-Forwarded-For carries the visitor's address
// (Tailscale sets it, overwriting any copy the visitor sent).
describe('per-visitor login limit', () => {
  const wrong = { password: pw + 'x' }
  const right = { password: pw }
  const a = '203.0.113.7'
  const b = '198.51.100.20'

  it('limits two visitors separately, so one cannot lock out the other', async () => {
    const base = await start(await loginDeps(3))
    for (let i = 0; i < 3; i++) expect((await login(base, wrong, a)).status).toBe(401)
    expect((await login(base, right, a)).status).toBe(429)
    expect((await login(base, right, b)).status).toBe(204)
  })

  it('puts a missing, list or junk header in one shared bucket, so changing it gains nothing', async () => {
    const base = await start(await loginDeps(3))
    expect((await login(base, wrong)).status).toBe(401)
    expect((await login(base, wrong, 'not-an-ip')).status).toBe(401)
    expect((await login(base, wrong, `${a}, ${b}`)).status).toBe(401)
    expect((await login(base, right, '')).status).toBe(429)
    expect((await login(base, right, 'something-else')).status).toBe(429)
    expect((await login(base, right, `${b}, ${a}`)).status).toBe(429)
    expect((await login(base, right)).status).toBe(429)
    // A visitor with a real address is not affected.
    expect((await login(base, right, a)).status).toBe(204)
  })

  it('resets only the visitor who logged in', async () => {
    const base = await start(await loginDeps(3))
    for (let i = 0; i < 2; i++) expect((await login(base, wrong, a)).status).toBe(401)
    for (let i = 0; i < 2; i++) expect((await login(base, wrong, b)).status).toBe(401)
    expect((await login(base, right, b)).status).toBe(204)
    expect((await login(base, wrong, a)).status).toBe(401)
    expect((await login(base, right, a)).status).toBe(429)
  })
})

describe('auth not configured', () => {
  it('keeps /api and /mcp closed and answers 503 on login', async () => {
    const logs: string[] = []
    const base = await start(createAuthDeps({ passwordHash: null, mcpToken: null, sessionStore: createMemorySessionStore(), mcpTokenStore: createMemoryMcpTokenStore() }, (line) => logs.push(line)))
    expect((await searchWith(base)).status).toBe(401)
    const res = await login(base, { password: pw })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'auth_not_configured' } })
    expect((await fetch(`${base}/mcp`, { headers: { authorization: 'Bearer anything' } })).status).toBe(401)
    expect(logs.join('\n')).toMatch(/PYTHIA_PASSWORD_HASH/)
    expect(logs.join('\n')).toMatch(/PYTHIA_MCP_TOKEN/)
  })

  it('rejects an invalid hash at startup', () => {
    expect(() => createAuthDeps({ passwordHash: 'nope', mcpToken: null, sessionStore: createMemorySessionStore(), mcpTokenStore: createMemoryMcpTokenStore() }, () => {})).toThrow(
      /PYTHIA_PASSWORD_HASH/,
    )
  })
})

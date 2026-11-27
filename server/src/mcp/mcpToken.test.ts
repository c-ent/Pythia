import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import type { AuthDeps } from '../routes/auth.js'
import { testAuth } from '../routes/testAuth.js'
import type { SearchService } from '../search/searchService.js'
import { sha256Hex } from '../security/session.js'
import { createMcpTokenService, createMemoryMcpTokenStore } from './mcpToken.js'

const envToken = 'env-mcp-token-' + 'e'.repeat(30)
const now = Date.UTC(2026, 10, 26, 12)

describe('MCP token service', () => {
  it('uses the .env token until the first rotation', async () => {
    const mcp = createMcpTokenService({ envToken, store: createMemoryMcpTokenStore() })
    expect(await mcp.verify(envToken)).toBe(true)
    expect(await mcp.verify(envToken + 'x')).toBe(false)
    expect(await mcp.verify('')).toBe(false)
    expect(await mcp.status()).toEqual({ source: 'env', last4: envToken.slice(-4), rotatedAt: null })
  })

  it('opens nothing when no token is set', async () => {
    const mcp = createMcpTokenService({ envToken: null, store: createMemoryMcpTokenStore() })
    expect(await mcp.verify('')).toBe(false)
    expect(await mcp.verify('anything')).toBe(false)
    expect(await mcp.status()).toEqual({ source: 'none', last4: null, rotatedAt: null })
  })

  it('after a rotation accepts only the new token and stores only its hash', async () => {
    const store = createMemoryMcpTokenStore()
    const mcp = createMcpTokenService({ envToken, store })
    const first = await mcp.rotate(now)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.last4).toBe(first.token.slice(-4))
    expect(store.stored()).toEqual({ tokenHash: sha256Hex(first.token), last4: first.last4, rotatedAt: new Date(now) })
    expect(JSON.stringify(store.stored())).not.toContain(first.token)
    expect(await mcp.verify(first.token)).toBe(true)
    expect(await mcp.verify(envToken)).toBe(false)
    expect(await mcp.status()).toEqual({ source: 'database', last4: first.last4, rotatedAt: new Date(now) })

    const second = await mcp.rotate(now + 1000)
    expect(second.token).not.toBe(first.token)
    expect(await mcp.verify(first.token)).toBe(false)
    expect(await mcp.verify(second.token)).toBe(true)
  })

  it('reads the store on every check, so another instance sees a rotation at once', async () => {
    const store = createMemoryMcpTokenStore()
    const a = createMcpTokenService({ envToken, store })
    const b = createMcpTokenService({ envToken, store })
    const { token } = await a.rotate(now)
    expect(await b.verify(envToken)).toBe(false)
    expect(await b.verify(token)).toBe(true)
  })
})

describe('MCP token routes', () => {
  const search = {} as SearchService
  const ask = {} as AskService
  const closers: (() => Promise<void>)[] = []
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function setup(env: string | null = envToken) {
    const t = await testAuth()
    const auth: AuthDeps = { ...t.auth, mcp: createMcpTokenService({ envToken: env, store: createMemoryMcpTokenStore() }) }
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise((resolve) => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const api = (path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, { ...init, headers: { cookie: t.cookie } })
    const mcpWith = (token: string) => fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })
    return { base, api, mcpWith }
  }

  it('need a web session', async () => {
    const { base } = await setup()
    expect((await fetch(`${base}/api/mcp-token`)).status).toBe(401)
    expect((await fetch(`${base}/api/mcp-token/rotate`, { method: 'POST' })).status).toBe(401)
    // The MCP token itself does not open them.
    const bearer = { authorization: `Bearer ${envToken}` }
    expect((await fetch(`${base}/api/mcp-token/rotate`, { method: 'POST', headers: bearer })).status).toBe(401)
  })

  it('shows the source and last 4 characters, never the token', async () => {
    const { api } = await setup()
    const res = await api('/mcp-token')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text).not.toContain(envToken)
    expect(JSON.parse(text)).toEqual({ source: 'env', last4: envToken.slice(-4), rotatedAt: null })

    const none = await setup(null)
    expect(await (await none.api('/mcp-token')).json()).toEqual({ source: 'none', last4: null, rotatedAt: null })
  })

  it('rotates: the old token gets 401 at once, the new one works, and nothing is logged', async () => {
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '))
      })
    }
    const { api, mcpWith } = await setup()
    // Past the token check the stateless MCP router answers GET with 405.
    expect((await mcpWith(envToken)).status).toBe(405)

    const res = await api('/mcp-token/rotate', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { token: string; last4: string; rotatedAt: string }
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(body.last4).toBe(body.token.slice(-4))

    expect((await mcpWith(envToken)).status).toBe(401)
    expect((await mcpWith(body.token)).status).toBe(405)

    const status = (await (await api('/mcp-token')).json()) as Record<string, unknown>
    expect(status).toEqual({ source: 'database', last4: body.last4, rotatedAt: body.rotatedAt })
    expect(JSON.stringify(status)).not.toContain(body.token)

    const again = (await (await api('/mcp-token/rotate', { method: 'POST' })).json()) as { token: string }
    expect((await mcpWith(body.token)).status).toBe(401)
    expect((await mcpWith(again.token)).status).toBe(405)

    for (const line of logged) {
      expect(line).not.toContain(body.token)
      expect(line).not.toContain(again.token)
    }
  })
})

import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import { ALWAYS_FREE_LIMITS, OFF_ORACLE_USAGE, type OracleUsageSnapshot } from '../health/oci/index.js'
import type { SearchService } from '../search/searchService.js'
import { testAuth } from './testAuth.js'

const { auth, cookie } = await testAuth()
const search = {} as SearchService
const ask = {} as AskService
let server: Server | undefined

async function start(overrides: { checksHealth?: 'ok' | 'broken'; oracle?: OracleUsageSnapshot } = {}) {
  const serverHealth = {
    async read() {
      return {
        sampledAt: '2026-11-28T00:00:00.000Z',
        cpu: { cores: 4, loadAverage: [0.1, 0.2, 0.3] as [number, number, number], busyPercent: 15 },
        memory: { totalBytes: 1000, availableBytes: 400, usedBytes: 600 },
        disk: { totalBytes: 2000, freeBytes: 500, usedBytes: 1500 },
        databaseBytes: 200,
        uptimeSeconds: { host: 1000, app: 200 },
        version: { app: '1.2.3', commit: 'abc123' },
      }
    },
    async health() {
      return { checkedAt: '2026-11-28T00:00:00.000Z', health: overrides.checksHealth ?? ('ok' as const), checks: {} as never }
    },
    ...(overrides.oracle === undefined ? {} : { oracle: () => overrides.oracle! }),
  }
  server = createServer(createApp({ search, ask, auth, hostMetrics: serverHealth }))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    get: (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }),
  }
}

afterEach(async () => {
  if (server !== undefined) await new Promise((resolve) => server!.close(resolve))
  server = undefined
})

describe('GET /api/status/server', () => {
  it('returns host metrics to a signed-in session without caching', async () => {
    const { get } = await start()
    const response = await get('/api/status/server', { cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      cpu: { cores: 4, busyPercent: 15 },
      memory: { totalBytes: 1000, usedBytes: 600 },
      disk: { totalBytes: 2000, freeBytes: 500 },
      databaseBytes: 200,
      uptimeSeconds: { host: 1000, app: 200 },
      version: { app: '1.2.3', commit: 'abc123' },
    })
  })

  it('requires a session and is not exposed through MCP', async () => {
    const { get } = await start()
    expect((await get('/api/status/server')).status).toBe(401)
    const mcp = await get('/mcp', { authorization: 'Bearer token', 'x-forwarded-for': '100.64.0.1' })
    expect(mcp.status).toBe(401)
    expect(await mcp.text()).not.toContain('busyPercent')
  })

  it('includes Oracle usage and sets health to warning unless a check is broken', async () => {
    const oracle: OracleUsageSnapshot = {
      state: 'ok',
      asOf: '2026-11-28T00:00:00.000Z',
      error: null,
      warnings: ['cost_above_zero'],
      usage: {
        a1Ocpus: { used: 2, limit: 4 },
        a1MemoryGb: { used: 12, limit: 24 },
        blockStorageGb: { used: 100, limit: 200 },
        volumeBackups: { used: 1, limit: 5 },
        outboundDataBytes: { used: 1000, limit: ALWAYS_FREE_LIMITS.outboundDataBytes },
        costThisMonth: { amount: 1.25, currency: 'USD' },
        reclaimRisk: { status: 'ok', cpuP95Percent: 30, networkPercent: 25, memoryPercent: 40, hasA1Instance: true },
      },
    }
    const warn = await start({ oracle })
    const warnRes = await warn.get('/api/status/server', { cookie })
    expect(await warnRes.json()).toMatchObject({ health: 'warning', oracle })

    await new Promise((resolve) => server!.close(resolve))
    server = undefined

    const broken = await start({ checksHealth: 'broken', oracle })
    const brokenRes = await broken.get('/api/status/server', { cookie })
    expect(await brokenRes.json()).toMatchObject({ health: 'broken', oracle })

    const fallback = await start()
    expect(await (await fallback.get('/api/status/server', { cookie })).json()).toMatchObject({ oracle: OFF_ORACLE_USAGE })
  })
})

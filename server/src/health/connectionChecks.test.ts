import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeminiSettingsService } from '../settings/geminiSettings.js'
import type { ServerStatus, StatusService } from '../sync/statusService.js'
import { createConnectionChecks } from './connectionChecks.js'

const emptyStatus = {
  sources: [
    { id: 'obsidian', state: 'healthy', reason: null },
    { id: 'github', state: 'healthy', reason: null },
    { id: 'gdrive', state: 'healthy', reason: null },
  ],
} as unknown as ServerStatus

function deps(overrides: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'nomic-embed-text:latest' }] })
    if (url.endsWith('/api/ps')) return Response.json({ models: [] })
    return Response.json({ rate: { remaining: 1234 } })
  })
  const pool = { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) } as unknown as Pool
  const gemini = { status: vi.fn(async () => ({ configured: false })), available: vi.fn(async () => true) }
  const status = { status: vi.fn(async () => emptyStatus) }
  return {
    fetch,
    pool,
    gemini,
    status,
    options: {
      pool,
      ollamaUrl: 'http://ollama:11434/',
      gemini: gemini as unknown as GeminiSettingsService,
      githubToken: null,
      vaultPath: null,
      status: status as unknown as StatusService,
      fetch: fetch as typeof globalThis.fetch,
      access: vi.fn(async () => {}),
      ...overrides,
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('connection checks', () => {
  it('reports installed and loaded model states, remaining rate limit, and off integrations', async () => {
    const setup = deps({ githubToken: 'fake-token', vaultPath: 'C:/vault' })
    setup.fetch.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'nomic-embed-text:latest' }] })
      if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'nomic-embed-text:latest' }] })
      return Response.json({ rate: { remaining: 321 } })
    })
    const checks = createConnectionChecks(setup.options)
    const result = await checks.read()
    expect(result.health).toBe('ok')
    expect(result.checks.ollama).toMatchObject({ state: 'ok', modelInstalled: true, modelLoaded: true })
    expect(result.checks.github).toMatchObject({ state: 'ok', remainingCore: 321 })
    expect(result.checks.vault.state).toBe('ok')
    expect(result.checks.gemini.state).toBe('off')
    expect(setup.options.access).toHaveBeenCalledWith('C:/vault', expect.any(Number))
  })

  it('marks a hanging check broken after its timeout and does not leak its error message', async () => {
    const setup = deps({ timeoutMs: 5 })
    setup.pool.query = vi.fn(() => new Promise(() => {})) as never
    const result = await createConnectionChecks(setup.options).read()
    expect(result.checks.postgres).toMatchObject({ state: 'broken', reason: 'TimeoutError' })
    expect(JSON.stringify(result)).not.toContain('POSTGRES_PASSWORD')
  })

  it('turns an unset token off and caches a complete snapshot for 30 seconds', async () => {
    vi.useFakeTimers()
    const setup = deps()
    const checks = createConnectionChecks({ ...setup.options, now: Date.now })
    const first = await checks.read()
    await checks.read()
    expect(setup.fetch).toHaveBeenCalledTimes(2)
    expect(first.checks.github).toEqual({ state: 'off', reason: null })
    await vi.advanceTimersByTimeAsync(30_001)
    await checks.read()
    expect(setup.fetch).toHaveBeenCalledTimes(4)
  })

  it('uses safe HTTP status reasons and flags R18 source errors as broken', async () => {
    const setup = deps({ githubToken: 'secret-token' })
    setup.fetch.mockImplementation(async (input) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [] })
      if (String(input).endsWith('/api/ps')) return Response.json({ models: [] })
      return new Response('forbidden secret-token', { status: 403 })
    })
    setup.status.status.mockResolvedValue({
      ...emptyStatus,
      sources: [{ id: 'obsidian', state: 'error', reason: 'scan failed: Error' }],
    } as unknown as ServerStatus)
    const result = await createConnectionChecks(setup.options).read()
    expect(result.checks.github).toMatchObject({ state: 'broken', reason: 'Http403' })
    expect(result.checks.sources).toMatchObject({ state: 'broken', reason: '1 source(s) error' })
    expect(result.health).toBe('broken')
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })

  it('does not mark overall server health broken when only a source is in error', async () => {
    const setup = deps()
    setup.status.status.mockResolvedValue({
      ...emptyStatus,
      sources: [{ id: 'gdrive', state: 'error', reason: 'DrivePullError' }],
    } as unknown as ServerStatus)
    const result = await createConnectionChecks(setup.options).read()
    expect(result.checks.sources).toMatchObject({ state: 'broken', reason: '1 source(s) error' })
    expect(result.health).toBe('ok')
  })

  it('reports Oracle off when unset and includes Oracle ok/broken/timeout in health', async () => {
    const offResult = await createConnectionChecks(deps().options).read()
    expect(offResult.checks.oracle).toEqual({ state: 'off', reason: null })

    const okResult = await createConnectionChecks(
      deps({ oci: { checkHealth: vi.fn(async () => ({ state: 'ok' as const, reason: null })) } }).options,
    ).read()
    expect(okResult.checks.oracle).toEqual({ state: 'ok', reason: null })
    expect(okResult.health).toBe('ok')

    const brokenResult = await createConnectionChecks(
      deps({
        timeoutMs: 5,
        oci: { checkHealth: vi.fn(() => new Promise(() => {})) },
      }).options,
    ).read()
    expect(brokenResult.checks.oracle).toEqual({ state: 'broken', reason: 'TimeoutError' })
    expect(brokenResult.health).toBe('broken')
  })
})

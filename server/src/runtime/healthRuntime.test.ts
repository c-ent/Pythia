import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { loadConfig } from '../config.js'
import { createHealthRuntime } from './healthRuntime.js'

describe('createHealthRuntime', () => {
  it('exposes serverHealth, overall health, and idempotent close()', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [{ '?column?': 1, ok: 1 }] })),
    } as unknown as Pool
    const config = loadConfig({
      POSTGRES_PASSWORD: 'test-password',
      PYTHIA_SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    })
    const status = {
      summary: vi.fn(async () => ({
        sources: [],
        activity: [],
        devices: 0,
        gemini: false,
        vault: null,
        repos: null,
        syncing: { active: false, startedAt: null, lastRunAt: null },
        drive: null,
      })),
    }

    const runtime = createHealthRuntime({
      pool,
      config,
      gemini: { available: () => false, status: vi.fn() } as unknown as Parameters<typeof createHealthRuntime>[0]['gemini'],
      status: status as unknown as Parameters<typeof createHealthRuntime>[0]['status'],
      gitCommit: 'test-sha',
    })

    expect(runtime.serverHealth.oracle?.()).toMatchObject({ state: 'off' })
    expect(runtime.serverHealth.storage?.()).toBeTruthy()
    expect(() => runtime.close()).not.toThrow()
    expect(() => runtime.close()).not.toThrow()
  })
})

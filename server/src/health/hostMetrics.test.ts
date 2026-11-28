import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { cpuBusyPercent, createHostMetrics, parseCpuStat, parseMeminfo } from './hostMetrics.js'

const meminfo = 'MemTotal:       1000 kB\nMemAvailable:    400 kB\n'
const pool = {} as Pool

const stat = (user: number, idle: number) => `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 0 0 0 0\n`

afterEach(() => vi.useRealTimers())

describe('host metrics', () => {
  it('parses host memory from /proc/meminfo fixture text', () => {
    expect(parseMeminfo(meminfo)).toEqual({ totalBytes: 1_024_000, availableBytes: 409_600, usedBytes: 614_400 })
    expect(() => parseMeminfo('MemTotal: 100 kB')).toThrow('InvalidMeminfo')
  })

  it('parses aggregate CPU counters and computes host busy percentage', () => {
    expect(parseCpuStat(stat(10, 90))).toEqual({ total: 100, idle: 90 })
    expect(cpuBusyPercent({ total: 100, idle: 90 }, { total: 200, idle: 170 })).toBe(20)
    expect(cpuBusyPercent({ total: 100, idle: 90 }, { total: 100, idle: 90 })).toBe(0)
    expect(() => parseCpuStat('cpu0 0 0 0 0')).toThrow('InvalidCpuStat')
  })

  it('samples CPU every 10 seconds and reports host, disk, DB and app metadata', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const cpu = [stat(10, 90), stat(40, 160)]
    const metrics = createHostMetrics(pool, {
      now: () => now,
      readCpuStat: async () => cpu.shift() ?? stat(40, 160),
      readMeminfo: async () => meminfo,
      statfs: async () => ({ blocks: 1000, bfree: 250, bsize: 4096 }),
      databaseSize: async () => 12_345,
      loadAverage: () => [0.1, 0.2, 0.3],
      cpuCount: () => 2,
      hostUptime: () => 500,
      appUptime: () => 20,
      appVersion: '1.2.3',
      commit: 'abc123',
    })
    await vi.waitFor(() => expect(cpu).toHaveLength(1))
    now += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await metrics.read()
    expect(result).toEqual({
      sampledAt: new Date(now).toISOString(),
      cpu: { cores: 2, loadAverage: [0.1, 0.2, 0.3], busyPercent: 30 },
      memory: { totalBytes: 1_024_000, availableBytes: 409_600, usedBytes: 614_400 },
      disk: { totalBytes: 4_096_000, freeBytes: 1_024_000, usedBytes: 3_072_000 },
      databaseBytes: 12_345,
      uptimeSeconds: { host: 500, app: 20 },
      version: { app: '1.2.3', commit: 'abc123' },
    })
    metrics.close()
  })
})

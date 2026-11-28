import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import {
  cpuBusyPercent,
  createHostMetrics,
  parseCpuStat,
  parseMeminfo,
  parseProcessStat,
  parseProcessStatusMemory,
  type RawProcessSample,
} from './hostMetrics.js'

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

  it('parses /proc/<pid>/stat including process names with spaces or parentheses and VmRSS', () => {
    const line =
      '42 (my (proc) name) S 1 42 42 0 -1 4194304 100 0 0 0 120 30 0 0 20 0 1 0 9999 100000 50 18446744073709551615'
    expect(parseProcessStat(line)).toEqual({
      pid: 42,
      name: 'my (proc) name',
      ticks: 150,
      startTime: 9999,
    })
    expect(parseProcessStat('invalid')).toBeNull()
    expect(parseProcessStatusMemory('Name:\tollama\nVmRSS:\t  524288 kB\n')).toBe(524_288 * 1024)
    expect(parseProcessStatusMemory('Name:\tkworker\n')).toBe(0)
  })

  it('samples CPU and process CPU/memory every 10 seconds and reports host, disk, DB and app metadata', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const cpu = [stat(10, 90), stat(40, 160)]
    const procSamples: RawProcessSample[][] = [
      [
        { pid: 1, name: 'systemd', ticks: 10, startTime: 1, memoryBytes: 12_000 },
        { pid: 20, name: 'ollama', ticks: 100, startTime: 50, memoryBytes: 500_000 },
        { pid: 30, name: 'postgres', ticks: 50, startTime: 60, memoryBytes: 200_000 },
      ],
      [
        { pid: 1, name: 'systemd', ticks: 10, startTime: 1, memoryBytes: 12_000 },
        { pid: 20, name: 'ollama', ticks: 125, startTime: 50, memoryBytes: 600_000 },
        { pid: 30, name: 'postgres', ticks: 55, startTime: 60, memoryBytes: 250_000 },
      ],
    ]
    const metrics = createHostMetrics(pool, {
      now: () => now,
      readCpuStat: async () => cpu.shift() ?? stat(40, 160),
      readProcesses: async () => procSamples.shift() ?? [],
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
      processes: {
        scope: 'host',
        totalCount: 3,
        topCpu: [
          { pid: 20, name: 'ollama', cpuPercent: 25, memoryBytes: 600_000 },
          { pid: 30, name: 'postgres', cpuPercent: 5, memoryBytes: 250_000 },
          { pid: 1, name: 'systemd', cpuPercent: 0, memoryBytes: 12_000 },
        ],
        topMemory: [
          { pid: 20, name: 'ollama', cpuPercent: 25, memoryBytes: 600_000 },
          { pid: 30, name: 'postgres', cpuPercent: 5, memoryBytes: 250_000 },
          { pid: 1, name: 'systemd', cpuPercent: 0, memoryBytes: 12_000 },
        ],
      },
    })
    metrics.close()
  })

  it('falls back to self scope when /proc is unavailable', async () => {
    const metrics = createHostMetrics(pool, {
      readCpuStat: async () => stat(10, 90),
      readProcesses: async () => null,
      readMeminfo: async () => meminfo,
      statfs: async () => ({ blocks: 1000, bfree: 250, bsize: 4096 }),
      databaseSize: async () => 100,
    })
    await vi.waitFor(async () => {
      const result = await metrics.read()
      expect(result.processes.scope).toBe('self')
      expect(result.processes.totalCount).toBe(1)
      expect(result.processes.topMemory[0]?.name).toBe('node')
    })
    metrics.close()
  })
})

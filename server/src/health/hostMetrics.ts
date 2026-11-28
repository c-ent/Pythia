import { readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import type { Pool } from 'pg'

const SAMPLE_INTERVAL_MS = 10_000
const MEMINFO_PATH = '/proc/meminfo'
const STAT_PATH = '/proc/stat'

export interface CpuSample {
  total: number
  idle: number
}

export interface HostMetrics {
  sampledAt: string
  cpu: { cores: number; loadAverage: [number, number, number]; busyPercent: number }
  memory: { totalBytes: number; availableBytes: number; usedBytes: number }
  disk: { totalBytes: number; freeBytes: number; usedBytes: number }
  databaseBytes: number
  uptimeSeconds: { host: number; app: number }
  version: { app: string; commit: string | null }
}

export interface HostMetricsOptions {
  now?: () => number
  loadAverage?: () => [number, number, number]
  cpuCount?: () => number
  readMeminfo?: () => Promise<string>
  readCpuStat?: () => Promise<string>
  statfs?: (path: string) => Promise<{ blocks: number | bigint; bfree: number | bigint; bsize: number | bigint }>
  databaseSize?: () => Promise<number>
  hostUptime?: () => number
  appUptime?: () => number
  appVersion?: string
  commit?: string | null
  cwd?: string
  sampleIntervalMs?: number
}

export function parseCpuStat(text: string): CpuSample {
  const line = text.split(/\r?\n/).find((entry) => /^cpu\s/.test(entry))
  if (line === undefined) throw new Error('InvalidCpuStat')
  const counters = line.trim().split(/\s+/).slice(1).map(Number)
  if (counters.length < 4 || counters.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('InvalidCpuStat')
  const idle = counters[3]! + (counters[4] ?? 0)
  return { total: counters.reduce((sum, value) => sum + value, 0), idle }
}

export function cpuBusyPercent(previous: CpuSample, current: CpuSample): number {
  const total = current.total - previous.total
  const idle = current.idle - previous.idle
  if (total <= 0 || idle < 0) return 0
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100))
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number; usedBytes: number } {
  const values = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/.exec(line)
    if (match !== null) values.set(match[1]!, Number(match[2]) * 1024)
  }
  const totalBytes = values.get('MemTotal')
  const availableBytes = values.get('MemAvailable')
  if (totalBytes === undefined || availableBytes === undefined || availableBytes > totalBytes) {
    throw new Error('InvalidMeminfo')
  }
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes }
}

const asNumber = (value: number | bigint): number => Number(value)

/** Samples aggregate CPU use in the background and reads host metrics on demand. */
export function createHostMetrics(pool: Pool, options: HostMetricsOptions = {}) {
  const now = options.now ?? Date.now
  const intervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS
  const startedAt = now()
  let previousCpu: CpuSample | null = null
  let busyPercent = 0
  let sampledAt = startedAt

  const sample = async (): Promise<void> => {
    try {
      const currentCpu = parseCpuStat(await (options.readCpuStat ?? (() => readFile(STAT_PATH, 'utf8')))())
      if (previousCpu !== null) busyPercent = cpuBusyPercent(previousCpu, currentCpu)
      previousCpu = currentCpu
      sampledAt = now()
    } catch {
      // Retain the last valid host sample if procfs is temporarily unreadable.
    }
  }
  void sample()
  const timer = setInterval(() => void sample(), intervalMs)
  timer.unref()

  return {
    async read(): Promise<HostMetrics> {
      const memText = await (options.readMeminfo ?? (() => readFile(MEMINFO_PATH, 'utf8')))()
      const memory = parseMeminfo(memText)
      const fs = await (options.statfs ?? statfs)(options.cwd ?? process.cwd())
      const blocks = asNumber(fs.blocks)
      const freeBlocks = asNumber(fs.bfree)
      const blockSize = asNumber(fs.bsize)
      const totalBytes = blocks * blockSize
      const freeBytes = freeBlocks * blockSize
      const { rows } = options.databaseSize === undefined
        ? await pool.query<{ size: string }>('SELECT pg_database_size(current_database()) AS size')
        : { rows: [{ size: String(await options.databaseSize()) }] }
      const databaseBytes = Number(rows[0]?.size)
      if (!Number.isFinite(databaseBytes)) throw new Error('InvalidDatabaseSize')
      const loads = (options.loadAverage ?? os.loadavg)()
      return {
        sampledAt: new Date(sampledAt).toISOString(),
        cpu: {
          cores: (options.cpuCount ?? os.availableParallelism)(),
          loadAverage: [loads[0], loads[1], loads[2]],
          busyPercent,
        },
        memory,
        disk: { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes },
        databaseBytes,
        uptimeSeconds: { host: (options.hostUptime ?? (() => os.uptime()))(), app: (options.appUptime ?? (() => process.uptime()))() },
        version: { app: options.appVersion ?? process.env.npm_package_version ?? 'unknown', commit: options.commit ?? process.env.PYTHIA_GIT_COMMIT ?? null },
      }
    },
    close(): void {
      clearInterval(timer)
    },
  }
}

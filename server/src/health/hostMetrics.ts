import { readdir, readFile, statfs } from 'node:fs/promises'
import os from 'node:os'
import type { Pool } from 'pg'

const SAMPLE_INTERVAL_MS = 10_000
const MEMINFO_PATH = '/proc/meminfo'
const STAT_PATH = '/proc/stat'
const PROC_PATH = '/proc'
const TOP_PROCESS_COUNT = 8
const PROC_READ_BATCH = 32

export interface CpuSample {
  total: number
  idle: number
}

export interface RawProcessSample {
  pid: number
  name: string
  ticks: number
  startTime: number
  memoryBytes: number
}

export interface ProcessUsage {
  pid: number
  name: string
  cpuPercent: number
  memoryBytes: number
}

export type ProcessScope = 'host' | 'container' | 'self'

export interface ProcessBreakdown {
  scope: ProcessScope
  totalCount: number
  topCpu: ProcessUsage[]
  topMemory: ProcessUsage[]
}

export interface HostMetrics {
  sampledAt: string
  cpu: { cores: number; loadAverage: [number, number, number]; busyPercent: number }
  memory: { totalBytes: number; availableBytes: number; usedBytes: number }
  disk: { totalBytes: number; freeBytes: number; usedBytes: number }
  databaseBytes: number
  uptimeSeconds: { host: number; app: number }
  version: { app: string; commit: string | null }
  processes: ProcessBreakdown
}

export interface HostMetricsOptions {
  now?: () => number
  loadAverage?: () => [number, number, number]
  cpuCount?: () => number
  readMeminfo?: () => Promise<string>
  readCpuStat?: () => Promise<string>
  readProcesses?: () => Promise<RawProcessSample[] | null>
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

export function parseProcessStat(text: string): { pid: number; name: string; ticks: number; startTime: number } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 1 || close <= open) return null
  const pid = Number(text.slice(0, open).trim())
  const name = text.slice(open + 1, close)
  const rest = text.slice(close + 2).trim().split(/\s+/)
  if (!Number.isInteger(pid) || pid <= 0 || rest.length < 22) return null
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  const startTime = Number(rest[19])
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(startTime)) return null
  return { pid, name: name || 'unknown', ticks: utime + stime, startTime }
}

export function parseProcessStatusMemory(text: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text)
  return match === null ? 0 : Number(match[1]) * 1024
}

export async function readProcProcesses(procPath = PROC_PATH): Promise<RawProcessSample[] | null> {
  let entries: string[]
  try {
    entries = await readdir(procPath)
  } catch {
    return null
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry))
  const results: RawProcessSample[] = []
  for (let i = 0; i < pids.length; i += PROC_READ_BATCH) {
    const batch = pids.slice(i, i + PROC_READ_BATCH)
    const settled = await Promise.all(
      batch.map(async (pidText): Promise<RawProcessSample | null> => {
        try {
          const [statText, statusText] = await Promise.all([
            readFile(`${procPath}/${pidText}/stat`, 'utf8'),
            readFile(`${procPath}/${pidText}/status`, 'utf8').catch(() => ''),
          ])
          const parsed = parseProcessStat(statText)
          if (parsed === null) return null
          return {
            ...parsed,
            memoryBytes: parseProcessStatusMemory(statusText),
          }
        } catch {
          return null
        }
      }),
    )
    for (const row of settled) {
      if (row !== null) results.push(row)
    }
  }
  return results
}

const roundPercent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10

function detectProcessScope(samples: RawProcessSample[]): ProcessScope {
  const pid1 = samples.find((entry) => entry.pid === 1)
  if (pid1 !== undefined && (pid1.name === 'node' || pid1.name === 'sh' || pid1.name === 'docker-init')) {
    return 'container'
  }
  return 'host'
}

const asNumber = (value: number | bigint): number => Number(value)

/** Samples aggregate CPU and per-process CPU/memory in the background and reads host metrics on demand. */
export function createHostMetrics(pool: Pool, options: HostMetricsOptions = {}) {
  const now = options.now ?? Date.now
  const intervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS
  const cpuCount = options.cpuCount ?? os.availableParallelism
  const startedAt = now()
  let previousCpu: CpuSample | null = null
  let previousProcs = new Map<number, { ticks: number; startTime: number }>()
  let previousSelfCpu: NodeJS.CpuUsage | null = null
  let previousSelfAt = startedAt
  let busyPercent = 0
  let sampledAt = startedAt
  let processes: ProcessBreakdown = {
    scope: 'self',
    totalCount: 1,
    topCpu: [{ pid: process.pid, name: 'node', cpuPercent: 0, memoryBytes: process.memoryUsage().rss }],
    topMemory: [{ pid: process.pid, name: 'node', cpuPercent: 0, memoryBytes: process.memoryUsage().rss }],
  }

  const sample = async (): Promise<void> => {
    const timestamp = now()
    let currentCpu: CpuSample | null = null
    try {
      currentCpu = parseCpuStat(await (options.readCpuStat ?? (() => readFile(STAT_PATH, 'utf8')))())
      if (previousCpu !== null) busyPercent = cpuBusyPercent(previousCpu, currentCpu)
      sampledAt = timestamp
    } catch {
      // Retain the last valid host sample if procfs is temporarily unreadable.
    }

    try {
      const rawProcs = await (options.readProcesses ?? (() => readProcProcesses(PROC_PATH)))()
      if (rawProcs === null) {
        const selfCpu = process.cpuUsage()
        let selfPercent = 0
        if (previousSelfCpu !== null) {
          const elapsedMicros = Math.max(1, (timestamp - previousSelfAt) * 1000 * Math.max(1, cpuCount()))
          const usedMicros = (selfCpu.user - previousSelfCpu.user) + (selfCpu.system - previousSelfCpu.system)
          selfPercent = roundPercent((usedMicros / elapsedMicros) * 100)
        }
        previousSelfCpu = selfCpu
        previousSelfAt = timestamp
        const selfRow: ProcessUsage = {
          pid: process.pid,
          name: 'node',
          cpuPercent: selfPercent,
          memoryBytes: process.memoryUsage().rss,
        }
        processes = { scope: 'self', totalCount: 1, topCpu: [selfRow], topMemory: [selfRow] }
      } else {
        const totalDelta = currentCpu !== null && previousCpu !== null ? currentCpu.total - previousCpu.total : 0
        const nextProcs = new Map<number, { ticks: number; startTime: number }>()
        const computed: ProcessUsage[] = rawProcs.map((proc) => {
          nextProcs.set(proc.pid, { ticks: proc.ticks, startTime: proc.startTime })
          const prev = previousProcs.get(proc.pid)
          const cpuPercent =
            prev !== undefined && prev.startTime === proc.startTime && totalDelta > 0 && proc.ticks >= prev.ticks
              ? roundPercent(((proc.ticks - prev.ticks) / totalDelta) * 100)
              : 0
          return { pid: proc.pid, name: proc.name, cpuPercent, memoryBytes: proc.memoryBytes }
        })
        previousProcs = nextProcs
        const topCpu = [...computed]
          .sort((a, b) => b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes || a.pid - b.pid)
          .slice(0, TOP_PROCESS_COUNT)
        const topMemory = [...computed]
          .sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.pid - b.pid)
          .slice(0, TOP_PROCESS_COUNT)
        processes = {
          scope: detectProcessScope(rawProcs),
          totalCount: rawProcs.length,
          topCpu,
          topMemory,
        }
      }
    } catch {
      // Keep the last process breakdown if reading /proc fails.
    }

    if (currentCpu !== null) previousCpu = currentCpu
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
          cores: cpuCount(),
          loadAverage: [loads[0], loads[1], loads[2]],
          busyPercent,
        },
        memory,
        disk: { totalBytes, freeBytes, usedBytes: totalBytes - freeBytes },
        databaseBytes,
        uptimeSeconds: { host: (options.hostUptime ?? (() => os.uptime()))(), app: (options.appUptime ?? (() => process.uptime()))() },
        version: { app: options.appVersion ?? process.env.npm_package_version ?? 'unknown', commit: options.commit ?? process.env.PYTHIA_GIT_COMMIT ?? null },
        processes,
      }
    },
    close(): void {
      clearInterval(timer)
    },
  }
}

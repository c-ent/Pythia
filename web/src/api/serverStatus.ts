import { ApiError, apiFetch } from './client'
import type { ServerHealth } from './status'

export const SERVER_CHECK_LABELS: Record<string, string> = {
  postgres: 'PostgreSQL',
  ollama: 'Ollama',
  gemini: 'Gemini',
  github: 'GitHub token',
  vault: 'Vault folder',
  sources: 'Sources',
  oracle: 'Oracle Cloud',
}

export const serverCheckLabel = (name: string): string => SERVER_CHECK_LABELS[name] ?? name

export interface ServerCheck {
  state: 'ok' | 'broken' | 'off'
  reason: string | null
  [detail: string]: unknown
}

export type OracleUsageState = 'off' | 'ok' | 'error'

export interface OracleMeter {
  used: number
  limit: number
}

export interface OracleCost {
  amount: number
  currency: string
}

export type ReclaimRiskStatus = 'ok' | 'at_risk' | 'unknown'

export interface OracleReclaimRisk {
  status: ReclaimRiskStatus
  cpuP95Percent: number | null
  networkPercent: number | null
  memoryPercent: number | null
  hasA1Instance: boolean
}

export type OracleWarningCode =
  | 'a1_ocpus_high'
  | 'a1_memory_high'
  | 'block_storage_high'
  | 'volume_backups_high'
  | 'outbound_data_high'
  | 'cost_above_zero'
  | 'reclaim_at_risk'

export interface OraclePlanUsage {
  a1Ocpus: OracleMeter
  a1MemoryGb: OracleMeter
  blockStorageGb: OracleMeter
  volumeBackups: OracleMeter
  outboundDataBytes: OracleMeter
  costThisMonth: OracleCost
  reclaimRisk: OracleReclaimRisk
}

export interface OracleUsageSnapshot {
  state: OracleUsageState
  asOf: string | null
  error: string | null
  warnings: OracleWarningCode[]
  usage: OraclePlanUsage | null
}

export const OFF_ORACLE_USAGE: OracleUsageSnapshot = {
  state: 'off',
  asOf: null,
  error: null,
  warnings: [],
  usage: null,
}

export interface ServerStatusDetails {
  sampledAt: string
  checkedAt: string
  health: ServerHealth
  cpu: { cores: number; loadAverage: [number, number, number]; busyPercent: number }
  memory: { totalBytes: number; availableBytes: number; usedBytes: number }
  disk: { totalBytes: number; freeBytes: number; usedBytes: number }
  databaseBytes: number
  uptimeSeconds: { host: number; app: number }
  version: { app: string; commit: string | null }
  checks: Record<string, ServerCheck>
  oracle: OracleUsageSnapshot
}

const badResponse = (): ApiError => new ApiError(500, 'bad_response', 'Unexpected response')
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullablePercent = (value: unknown): value is number | null => value === null || number(value)

function parseOracleMeter(value: unknown): OracleMeter | null {
  if (!isObject(value) || !number(value.used) || !number(value.limit)) return null
  return { used: value.used, limit: value.limit }
}

function parseReclaimRisk(value: unknown): OracleReclaimRisk | null {
  if (
    !isObject(value) ||
    !['ok', 'at_risk', 'unknown'].includes(String(value.status)) ||
    !nullablePercent(value.cpuP95Percent) ||
    !nullablePercent(value.networkPercent) ||
    !nullablePercent(value.memoryPercent) ||
    typeof value.hasA1Instance !== 'boolean'
  ) {
    return null
  }
  return {
    status: value.status as ReclaimRiskStatus,
    cpuP95Percent: value.cpuP95Percent,
    networkPercent: value.networkPercent,
    memoryPercent: value.memoryPercent,
    hasA1Instance: value.hasA1Instance,
  }
}

function parseOraclePlanUsage(value: unknown): OraclePlanUsage | null {
  if (!isObject(value)) return null
  const a1Ocpus = parseOracleMeter(value.a1Ocpus)
  const a1MemoryGb = parseOracleMeter(value.a1MemoryGb)
  const blockStorageGb = parseOracleMeter(value.blockStorageGb)
  const volumeBackups = parseOracleMeter(value.volumeBackups)
  const outboundDataBytes = parseOracleMeter(value.outboundDataBytes)
  const reclaimRisk = parseReclaimRisk(value.reclaimRisk)
  if (
    !a1Ocpus ||
    !a1MemoryGb ||
    !blockStorageGb ||
    !volumeBackups ||
    !outboundDataBytes ||
    !reclaimRisk ||
    !isObject(value.costThisMonth) ||
    !finiteNumber(value.costThisMonth.amount) ||
    typeof value.costThisMonth.currency !== 'string' ||
    value.costThisMonth.currency.trim() === ''
  ) {
    return null
  }
  return {
    a1Ocpus,
    a1MemoryGb,
    blockStorageGb,
    volumeBackups,
    outboundDataBytes,
    costThisMonth: { amount: value.costThisMonth.amount, currency: value.costThisMonth.currency },
    reclaimRisk,
  }
}

function parseOracleUsage(value: unknown): OracleUsageSnapshot {
  if (value === undefined) return OFF_ORACLE_USAGE
  if (
    !isObject(value) ||
    !['off', 'ok', 'error'].includes(String(value.state)) ||
    (value.asOf !== null && typeof value.asOf !== 'string') ||
    (value.error !== null && typeof value.error !== 'string') ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((entry): entry is OracleWarningCode => typeof entry === 'string')
  ) {
    throw badResponse()
  }
  const usage = value.usage === null ? null : parseOraclePlanUsage(value.usage)
  if (value.usage !== null && usage === null) throw badResponse()
  return {
    state: value.state as OracleUsageState,
    asOf: value.asOf,
    error: value.error,
    warnings: value.warnings,
    usage,
  }
}

function parseCheck(value: unknown): ServerCheck | null {
  if (!isObject(value) || !['ok', 'broken', 'off'].includes(String(value.state))) return null
  return {
    ...value,
    state: value.state as ServerCheck['state'],
    reason: typeof value.reason === 'string' ? value.reason : null,
  }
}

export function parseServerStatusDetails(value: unknown): ServerStatusDetails {
  if (!isObject(value) || !isObject(value.cpu) || !isObject(value.memory) || !isObject(value.disk) ||
      !isObject(value.uptimeSeconds) || !isObject(value.version) || !isObject(value.checks) ||
      typeof value.sampledAt !== 'string' || typeof value.checkedAt !== 'string') throw badResponse()
  const cpu = value.cpu
  const memory = value.memory
  const disk = value.disk
  const uptime = value.uptimeSeconds
  const version = value.version
  const loads = cpu.loadAverage
  if (!number(cpu.cores) || !number(cpu.busyPercent) || cpu.busyPercent > 100 ||
      !Array.isArray(loads) || loads.length !== 3 || !loads.every(number) ||
      !number(memory.totalBytes) || !number(memory.availableBytes) || !number(memory.usedBytes) ||
      !number(disk.totalBytes) || !number(disk.freeBytes) || !number(disk.usedBytes) ||
      !number(value.databaseBytes) || !number(uptime.host) || !number(uptime.app) ||
      typeof version.app !== 'string' || (version.commit !== null && typeof version.commit !== 'string')) throw badResponse()
  const checks = Object.fromEntries(Object.entries(value.checks).map(([name, check]) => [name, parseCheck(check)]))
  if (Object.values(checks).some((check) => check === null)) throw badResponse()
  const oracle = parseOracleUsage(value.oracle)
  return {
    sampledAt: value.sampledAt,
    checkedAt: value.checkedAt,
    health: value.health === 'broken' ? 'broken' : value.health === 'warning' ? 'warning' : 'ok',
    cpu: { cores: cpu.cores, busyPercent: cpu.busyPercent, loadAverage: loads as [number, number, number] },
    memory: { totalBytes: memory.totalBytes, availableBytes: memory.availableBytes, usedBytes: memory.usedBytes },
    disk: { totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedBytes: disk.usedBytes },
    databaseBytes: value.databaseBytes,
    uptimeSeconds: { host: uptime.host, app: uptime.app },
    version: { app: version.app, commit: version.commit },
    checks: checks as Record<string, ServerCheck>,
    oracle,
  }
}

export async function getServerStatusDetails(signal?: AbortSignal): Promise<ServerStatusDetails> {
  const response = await apiFetch('/api/status/server', { signal })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw badResponse()
  }
  return parseServerStatusDetails(body)
}

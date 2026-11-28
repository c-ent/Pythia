import type { OciClient } from './client.js'
import { OciHttpError, safeOciReason } from './client.js'

export const ORACLE_REFRESH_INTERVAL_MS = 15 * 60_000
export const ORACLE_REQUEST_TIMEOUT_MS = 15_000
export const WARNING_USAGE_RATIO = 0.9
export const RECLAIM_THRESHOLD_PERCENT = 20

const BYTES_PER_TB = 10 * 1024 ** 4
const A1_BANDWIDTH_BYTES_PER_OCPU = 125_000_000 // 1 Gbps per OCPU
const E2_MICRO_BANDWIDTH_BYTES = 60_000_000 // 480 Mbps
const DEFAULT_BANDWIDTH_BYTES = 125_000_000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ONE_HOUR_SECONDS = 3600

export const ALWAYS_FREE_LIMITS = {
  a1Ocpus: 4,
  a1MemoryGb: 24,
  blockStorageGb: 200,
  volumeBackups: 5,
  outboundDataBytes: BYTES_PER_TB,
} as const

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

export interface OracleUsageOptions {
  now?: () => number
  refreshIntervalMs?: number
  requestTimeoutMs?: number
  log?: (message: string) => void
}

export interface OracleUsageService {
  snapshot(): OracleUsageSnapshot
  refresh(): Promise<OracleUsageSnapshot>
  close(): void
}

interface RawCompartment {
  id?: unknown
  lifecycleState?: unknown
}

interface RawAvailabilityDomain {
  name?: unknown
}

interface RawInstance {
  id?: unknown
  shape?: unknown
  lifecycleState?: unknown
  shapeConfig?: {
    ocpus?: unknown
    memoryInGBs?: unknown
  } | null
}

interface RawVolume {
  sizeInGBs?: unknown
  lifecycleState?: unknown
}

interface RawBackup {
  lifecycleState?: unknown
}

interface RawLimitValue {
  name?: unknown
  scopeType?: unknown
  value?: unknown
}

interface RawResourceAvailability {
  used?: unknown
  fractionalUsage?: unknown
}

interface RawMetricStream {
  dimensions?: Record<string, unknown> | null
  aggregatedDatapoints?: Array<{ timestamp?: unknown; value?: unknown }> | null
}

interface RawUsageResponse {
  items?: Array<{ computedAmount?: unknown; currency?: unknown }> | null
}

interface ActiveInstance {
  id: string | null
  isA1: boolean
  ocpus: number
  memoryGb: number
  bandwidthBytesPerSec: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[]
  if (isRecord(value) && Array.isArray(value.items)) return value.items as T[]
  return []
}

const isActiveState = (state: unknown, excludeFaulty = false): boolean => {
  if (typeof state !== 'string') return true
  const upper = state.toUpperCase()
  if (upper === 'TERMINATED' || upper === 'TERMINATING') return false
  if (excludeFaulty && upper === 'FAULTY') return false
  return true
}

const isA1Shape = (shape: string): boolean => /\.A1\.|^VM\.Standard\.A1/i.test(shape)

function instanceBandwidthBytesPerSec(shape: string, ocpus: number): number {
  if (isA1Shape(shape)) {
    return Math.max(1, ocpus) * A1_BANDWIDTH_BYTES_PER_OCPU
  }
  if (/\.E2\.1\.Micro/i.test(shape)) {
    return E2_MICRO_BANDWIDTH_BYTES
  }
  return DEFAULT_BANDWIDTH_BYTES
}

function roundPercent(value: number): number {
  const clamped = Math.min(100, Math.max(0, value))
  return Math.round(clamped * 100) / 100
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))
  return sorted[index]!
}

function streamValues(stream: RawMetricStream): number[] {
  if (!Array.isArray(stream.aggregatedDatapoints)) return []
  const values: number[] = []
  for (const point of stream.aggregatedDatapoints) {
    const val = asFiniteNumber(point?.value)
    if (val !== null) values.push(val)
  }
  return values
}

function groupValuesByResource(streams: readonly RawMetricStream[]): {
  byResource: Map<string, number[]>
  all: number[]
} {
  const byResource = new Map<string, number[]>()
  const all: number[] = []
  for (const stream of streams) {
    const values = streamValues(stream)
    if (values.length === 0) continue
    all.push(...values)
    const resourceId = isRecord(stream.dimensions) && typeof stream.dimensions.resourceId === 'string'
      ? stream.dimensions.resourceId
      : null
    if (resourceId !== null) {
      const existing = byResource.get(resourceId)
      if (existing === undefined) byResource.set(resourceId, [...values])
      else existing.push(...values)
    }
  }
  return { byResource, all }
}

function sumHourlySeries(streams: readonly RawMetricStream[]): number[] {
  const byTimestamp = new Map<string, number>()
  const fallback: number[] = []
  for (const stream of streams) {
    if (!Array.isArray(stream.aggregatedDatapoints)) continue
    for (const point of stream.aggregatedDatapoints) {
      const val = asFiniteNumber(point?.value)
      if (val === null) continue
      if (typeof point.timestamp === 'string') {
        byTimestamp.set(point.timestamp, (byTimestamp.get(point.timestamp) ?? 0) + val)
      } else {
        fallback.push(val)
      }
    }
  }
  return byTimestamp.size > 0 ? [...byTimestamp.values()] : fallback
}

function sumAllPoints(streams: readonly RawMetricStream[]): { total: number; hasData: boolean } {
  let total = 0
  let hasData = false
  for (const stream of streams) {
    for (const val of streamValues(stream)) {
      total += val
      hasData = true
    }
  }
  return { total, hasData }
}

function networkPercentFromHourlyBytes(bytesSeries: readonly number[], bandwidthBytesPerSec: number): number | null {
  if (bytesSeries.length === 0 || bandwidthBytesPerSec <= 0) return null
  const percents = bytesSeries.map((bytes) => (bytes / ONE_HOUR_SECONDS / bandwidthBytesPerSec) * 100)
  const p95 = percentile95(percents)
  return p95 === null ? null : roundPercent(p95)
}

/** Evaluates Oracle Always Free 7-day reclaim risk from CPU, network, and (A1 only) memory percentages. */
export function evaluateReclaimRisk(metrics: {
  cpuP95Percent: number | null
  networkPercent: number | null
  memoryPercent: number | null
  hasA1Instance: boolean
  instanceCount: number
}): OracleReclaimRisk {
  const { cpuP95Percent, networkPercent, memoryPercent, hasA1Instance, instanceCount } = metrics
  if (instanceCount === 0) {
    return { status: 'ok', cpuP95Percent, networkPercent, memoryPercent, hasA1Instance }
  }

  const checks: Array<number | null> = hasA1Instance
    ? [cpuP95Percent, networkPercent, memoryPercent]
    : [cpuP95Percent, networkPercent]

  if (checks.some((value) => value !== null && value >= RECLAIM_THRESHOLD_PERCENT)) {
    return { status: 'ok', cpuP95Percent, networkPercent, memoryPercent, hasA1Instance }
  }

  if (checks.every((value) => value !== null && value < RECLAIM_THRESHOLD_PERCENT)) {
    return { status: 'at_risk', cpuP95Percent, networkPercent, memoryPercent, hasA1Instance }
  }

  return { status: 'unknown', cpuP95Percent, networkPercent, memoryPercent, hasA1Instance }
}

function pickWorstInstanceReclaim(
  instances: readonly ActiveInstance[],
  cpuStreams: readonly RawMetricStream[],
  memoryStreams: readonly RawMetricStream[],
  vnicStreams: readonly RawMetricStream[],
  computeNetStreams: readonly RawMetricStream[],
): OracleReclaimRisk {
  if (instances.length === 0) {
    return { status: 'ok', cpuP95Percent: null, networkPercent: null, memoryPercent: null, hasA1Instance: false }
  }

  const cpu = groupValuesByResource(cpuStreams)
  const memory = groupValuesByResource(memoryStreams)
  const computeNet = groupValuesByResource(computeNetStreams)
  const vnicHourly = sumHourlySeries(vnicStreams)
  const totalBandwidth = instances.reduce((sum, inst) => sum + inst.bandwidthBytesPerSec, 0)

  if (instances.length === 1) {
    const inst = instances[0]!
    const cpuP95 = percentile95(cpu.all)
    const memP95 = inst.isA1 ? percentile95(memory.all) : null
    const netHourly = vnicHourly.length > 0 ? vnicHourly : sumHourlySeries(computeNetStreams)
    const netP95 = networkPercentFromHourlyBytes(netHourly, inst.bandwidthBytesPerSec)
    return evaluateReclaimRisk({
      cpuP95Percent: cpuP95 === null ? null : roundPercent(cpuP95),
      networkPercent: netP95,
      memoryPercent: memP95 === null ? null : roundPercent(memP95),
      hasA1Instance: inst.isA1,
      instanceCount: 1,
    })
  }

  const evaluations = instances.map((inst) => {
    const cpuValues = (inst.id !== null ? cpu.byResource.get(inst.id) : undefined) ?? cpu.all
    const memValues = inst.isA1 ? ((inst.id !== null ? memory.byResource.get(inst.id) : undefined) ?? memory.all) : []
    const instNetValues = inst.id !== null ? computeNet.byResource.get(inst.id) : undefined
    const cpuP95 = percentile95(cpuValues)
    const memP95 = inst.isA1 ? percentile95(memValues) : null
    const netP95 =
      instNetValues !== undefined
        ? networkPercentFromHourlyBytes(instNetValues, inst.bandwidthBytesPerSec)
        : networkPercentFromHourlyBytes(vnicHourly, totalBandwidth)

    return evaluateReclaimRisk({
      cpuP95Percent: cpuP95 === null ? null : roundPercent(cpuP95),
      networkPercent: netP95,
      memoryPercent: memP95 === null ? null : roundPercent(memP95),
      hasA1Instance: inst.isA1,
      instanceCount: 1,
    })
  })

  const atRisk = evaluations.find((entry) => entry.status === 'at_risk')
  if (atRisk !== undefined) return atRisk
  const unknown = evaluations.find((entry) => entry.status === 'unknown')
  return unknown ?? evaluations[0]!
}

const isNearLimit = (meter: OracleMeter): boolean => meter.limit > 0 && meter.used / meter.limit >= WARNING_USAGE_RATIO

/** Evaluates R21 warning rules: >=90% of any plan limit, cost above $0, or reclaim risk `at_risk`. */
export function evaluateOracleWarnings(usage: OraclePlanUsage): OracleWarningCode[] {
  const warnings: OracleWarningCode[] = []
  if (isNearLimit(usage.a1Ocpus)) warnings.push('a1_ocpus_high')
  if (isNearLimit(usage.a1MemoryGb)) warnings.push('a1_memory_high')
  if (isNearLimit(usage.blockStorageGb)) warnings.push('block_storage_high')
  if (isNearLimit(usage.volumeBackups)) warnings.push('volume_backups_high')
  if (isNearLimit(usage.outboundDataBytes)) warnings.push('outbound_data_high')
  if (usage.costThisMonth.amount > 0) warnings.push('cost_above_zero')
  if (usage.reclaimRisk.status === 'at_risk') warnings.push('reclaim_at_risk')
  return warnings
}

/** Combines connection checks (`broken` wins) with Oracle plan warnings (`warning`). */
export function combineOverallHealth(
  checksHealth: 'ok' | 'broken',
  oracle: OracleUsageSnapshot,
): 'ok' | 'warning' | 'broken' {
  if (checksHealth === 'broken') return 'broken'
  if (oracle.warnings.length > 0) return 'warning'
  return 'ok'
}

function monthRangeUtc(timestampMs: number): {
  monthStartIso: string
  usageStartIso: string
  usageEndIso: string
} {
  const nowDate = new Date(timestampMs)
  const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1, 0, 0, 0, 0))
  const tomorrowStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + 1, 0, 0, 0, 0))
  return {
    monthStartIso: monthStart.toISOString(),
    usageStartIso: monthStart.toISOString(),
    usageEndIso: tomorrowStart.toISOString(),
  }
}

function extractLimitMap(rows: readonly RawLimitValue[]): Map<string, { value: number; scopeType: string | null }> {
  const map = new Map<string, { value: number; scopeType: string | null }>()
  for (const row of rows) {
    if (typeof row.name !== 'string') continue
    const value = asFiniteNumber(row.value)
    if (value === null || value <= 0) continue
    const scopeType = typeof row.scopeType === 'string' ? row.scopeType : null
    const existing = map.get(row.name)
    if (existing === undefined || value > existing.value) {
      map.set(row.name, { value, scopeType })
    }
  }
  return map
}

async function fetchLimitAvailability(
  oci: Pick<OciClient, 'request'>,
  tenancyId: string,
  serviceName: 'compute-core' | 'block-storage',
  limitName: string,
  scopeType: string | null,
  availabilityDomains: readonly string[],
  signal?: AbortSignal,
): Promise<number | null> {
  const query: Record<string, string> = { compartmentId: tenancyId }
  if (scopeType === 'AD' && availabilityDomains.length > 0) {
    query.availabilityDomain = availabilityDomains[0]!
  }
  try {
    const raw = await oci.request<RawResourceAvailability>({
      service: 'limits',
      method: 'GET',
      path: `/20190729/services/${serviceName}/limits/${limitName}/resourceAvailability`,
      query,
      ...(signal === undefined ? {} : { signal }),
    })
    return asFiniteNumber(raw.fractionalUsage) ?? asFiniteNumber(raw.used)
  } catch (error) {
    if (error instanceof OciHttpError && error.status === 404) return null
    throw error
  }
}

async function fetchOracleUsage(
  oci: Pick<OciClient, 'request'>,
  tenancyId: string,
  timestampMs: number,
  signal?: AbortSignal,
): Promise<OraclePlanUsage> {
  const optSignal = signal === undefined ? {} : { signal }

  const [rawCompartments, rawAds, computeLimitRows, storageLimitRows] = await Promise.all([
    oci.request<unknown>({
      service: 'identity',
      method: 'GET',
      path: '/20160918/compartments',
      query: { compartmentId: tenancyId, compartmentIdInSubtree: 'true', accessLevel: 'ACCESSIBLE' },
      ...optSignal,
    }),
    oci.request<unknown>({
      service: 'identity',
      method: 'GET',
      path: '/20160918/availabilityDomains',
      query: { compartmentId: tenancyId },
      ...optSignal,
    }),
    oci.request<unknown>({
      service: 'limits',
      method: 'GET',
      path: '/20190729/limitValues',
      query: { compartmentId: tenancyId, serviceName: 'compute-core' },
      ...optSignal,
    }),
    oci.request<unknown>({
      service: 'limits',
      method: 'GET',
      path: '/20190729/limitValues',
      query: { compartmentId: tenancyId, serviceName: 'block-storage' },
      ...optSignal,
    }),
  ])

  const compartmentIds = new Set<string>([tenancyId])
  for (const row of asArray<RawCompartment>(rawCompartments)) {
    if (typeof row.id === 'string' && row.id.length > 0 && isActiveState(row.lifecycleState)) {
      compartmentIds.add(row.id)
    }
  }

  const availabilityDomains: string[] = []
  for (const row of asArray<RawAvailabilityDomain>(rawAds)) {
    if (typeof row.name === 'string' && row.name.length > 0) {
      availabilityDomains.push(row.name)
    }
  }

  const computeLimits = extractLimitMap(asArray<RawLimitValue>(computeLimitRows))
  const storageLimits = extractLimitMap(asArray<RawLimitValue>(storageLimitRows))
  const backupLimitKey = storageLimits.has('volume-backup-count') ? 'volume-backup-count' : 'backup-count'

  const sevenDaysAgoIso = new Date(timestampMs - SEVEN_DAYS_MS).toISOString()
  const nowIso = new Date(timestampMs).toISOString()
  const { monthStartIso, usageStartIso, usageEndIso } = monthRangeUtc(timestampMs)

  const inventoryPromise = Promise.all(
    [...compartmentIds].map(async (compartmentId) => {
      const [instances, volumes, volumeBackups, bootVolumeBackups, bootVolumesByAd] = await Promise.all([
        oci.request<unknown>({
          service: 'iaas',
          method: 'GET',
          path: '/20160918/instances',
          query: { compartmentId },
          ...optSignal,
        }),
        oci.request<unknown>({
          service: 'iaas',
          method: 'GET',
          path: '/20160918/volumes',
          query: { compartmentId },
          ...optSignal,
        }),
        oci.request<unknown>({
          service: 'iaas',
          method: 'GET',
          path: '/20160918/volumeBackups',
          query: { compartmentId },
          ...optSignal,
        }),
        oci.request<unknown>({
          service: 'iaas',
          method: 'GET',
          path: '/20160918/bootVolumeBackups',
          query: { compartmentId },
          ...optSignal,
        }),
        Promise.all(
          availabilityDomains.map((availabilityDomain) =>
            oci.request<unknown>({
              service: 'iaas',
              method: 'GET',
              path: '/20160918/bootVolumes',
              query: { compartmentId, availabilityDomain },
              ...optSignal,
            }),
          ),
        ),
      ])

      return {
        instances: asArray<RawInstance>(instances),
        volumes: asArray<RawVolume>(volumes),
        volumeBackups: asArray<RawBackup>(volumeBackups),
        bootVolumeBackups: asArray<RawBackup>(bootVolumeBackups),
        bootVolumes: bootVolumesByAd.flatMap((rows) => asArray<RawVolume>(rows)),
      }
    }),
  )

  const monitoringQuery = (namespace: 'oci_computeagent' | 'oci_vcn', query: string, startTime: string) =>
    oci.request<unknown>({
      service: 'telemetry',
      method: 'POST',
      path: '/20180401/metrics/actions/summarizeMetricsData',
      query: { compartmentId: tenancyId, compartmentIdInSubtree: 'true' },
      body: {
        namespace,
        query,
        startTime,
        endTime: nowIso,
        resolution: '1h',
      },
      ...optSignal,
    })

  const [
    inventories,
    availOcpus,
    availMemory,
    availStorage,
    availBackups,
    cpu7dRaw,
    memory7dRaw,
    net7dComputeRaw,
    net7dVcnRaw,
    outboundMonthComputeRaw,
    outboundMonthVcnRaw,
    usageRaw,
  ] = await Promise.all([
    inventoryPromise,
    fetchLimitAvailability(oci, tenancyId, 'compute-core', 'standard-a1-core-count', computeLimits.get('standard-a1-core-count')?.scopeType ?? null, availabilityDomains, signal),
    fetchLimitAvailability(oci, tenancyId, 'compute-core', 'standard-a1-memory-count', computeLimits.get('standard-a1-memory-count')?.scopeType ?? null, availabilityDomains, signal),
    fetchLimitAvailability(oci, tenancyId, 'block-storage', 'total-storage-gb', storageLimits.get('total-storage-gb')?.scopeType ?? null, availabilityDomains, signal),
    fetchLimitAvailability(oci, tenancyId, 'block-storage', backupLimitKey, storageLimits.get(backupLimitKey)?.scopeType ?? null, availabilityDomains, signal),
    monitoringQuery('oci_computeagent', 'CpuUtilization[1h].percentile(0.95)', sevenDaysAgoIso),
    monitoringQuery('oci_computeagent', 'MemoryUtilization[1h].percentile(0.95)', sevenDaysAgoIso),
    monitoringQuery('oci_computeagent', 'NetworksBytesOut[1h].sum()', sevenDaysAgoIso),
    monitoringQuery('oci_vcn', 'VnicToNetworkBytes[1h].sum()', sevenDaysAgoIso),
    monitoringQuery('oci_computeagent', 'NetworksBytesOut[1h].sum()', monthStartIso),
    monitoringQuery('oci_vcn', 'VnicToNetworkBytes[1h].sum()', monthStartIso),
    oci.request<RawUsageResponse>({
      service: 'usageapi',
      method: 'POST',
      path: '/20200107/usage',
      body: {
        tenantId: tenancyId,
        compartmentId: tenancyId,
        timeUsageStarted: usageStartIso,
        timeUsageEnded: usageEndIso,
        granularity: 'MONTHLY',
        queryType: 'COST',
      },
      ...optSignal,
    }),
  ])

  const activeInstances: ActiveInstance[] = []
  let a1OcpusUsed = 0
  let a1MemoryGbUsed = 0
  let blockStorageGbUsed = 0
  let volumeBackupsUsed = 0

  for (const part of inventories) {
    for (const inst of part.instances) {
      if (!isActiveState(inst.lifecycleState)) continue
      const shape = typeof inst.shape === 'string' ? inst.shape : ''
      const ocpus = asFiniteNumber(inst.shapeConfig?.ocpus) ?? 0
      const memoryGb = asFiniteNumber(inst.shapeConfig?.memoryInGBs) ?? 0
      const isA1 = isA1Shape(shape)
      if (isA1) {
        a1OcpusUsed += ocpus
        a1MemoryGbUsed += memoryGb
      }
      activeInstances.push({
        id: typeof inst.id === 'string' ? inst.id : null,
        isA1,
        ocpus,
        memoryGb,
        bandwidthBytesPerSec: instanceBandwidthBytesPerSec(shape, ocpus),
      })
    }

    for (const volume of [...part.volumes, ...part.bootVolumes]) {
      if (!isActiveState(volume.lifecycleState)) continue
      blockStorageGbUsed += asFiniteNumber(volume.sizeInGBs) ?? 0
    }

    for (const backup of [...part.volumeBackups, ...part.bootVolumeBackups]) {
      if (!isActiveState(backup.lifecycleState, true)) continue
      volumeBackupsUsed += 1
    }
  }

  if (a1OcpusUsed === 0 && availOcpus !== null && availOcpus > 0) a1OcpusUsed = availOcpus
  if (a1MemoryGbUsed === 0 && availMemory !== null && availMemory > 0) a1MemoryGbUsed = availMemory
  if (blockStorageGbUsed === 0 && availStorage !== null && availStorage > 0) blockStorageGbUsed = availStorage
  if (volumeBackupsUsed === 0 && availBackups !== null && availBackups > 0) volumeBackupsUsed = availBackups

  const monthVcn = sumAllPoints(asArray<RawMetricStream>(outboundMonthVcnRaw))
  const monthCompute = sumAllPoints(asArray<RawMetricStream>(outboundMonthComputeRaw))
  const outboundUsedBytes = monthVcn.total > 0 || !monthCompute.hasData ? monthVcn.total : monthCompute.total

  const usageItems = isRecord(usageRaw) && Array.isArray(usageRaw.items) ? usageRaw.items : []
  let costAmount = 0
  let currency: string | null = null
  for (const item of usageItems) {
    const amount = asFiniteNumber(item?.computedAmount)
    if (amount !== null) costAmount += amount
    if (currency === null && typeof item?.currency === 'string' && item.currency.trim().length > 0) {
      currency = item.currency.trim()
    }
  }
  costAmount = Math.round(costAmount * 10000) / 10000

  const reclaimRisk = pickWorstInstanceReclaim(
    activeInstances,
    asArray<RawMetricStream>(cpu7dRaw),
    asArray<RawMetricStream>(memory7dRaw),
    asArray<RawMetricStream>(net7dVcnRaw),
    asArray<RawMetricStream>(net7dComputeRaw),
  )

  return {
    a1Ocpus: {
      used: a1OcpusUsed,
      limit: computeLimits.get('standard-a1-core-count')?.value ?? ALWAYS_FREE_LIMITS.a1Ocpus,
    },
    a1MemoryGb: {
      used: a1MemoryGbUsed,
      limit: computeLimits.get('standard-a1-memory-count')?.value ?? ALWAYS_FREE_LIMITS.a1MemoryGb,
    },
    blockStorageGb: {
      used: blockStorageGbUsed,
      limit: storageLimits.get('total-storage-gb')?.value ?? ALWAYS_FREE_LIMITS.blockStorageGb,
    },
    volumeBackups: {
      used: volumeBackupsUsed,
      limit: storageLimits.get(backupLimitKey)?.value ?? ALWAYS_FREE_LIMITS.volumeBackups,
    },
    outboundDataBytes: {
      used: outboundUsedBytes,
      limit: ALWAYS_FREE_LIMITS.outboundDataBytes,
    },
    costThisMonth: {
      amount: costAmount,
      currency: currency ?? 'USD',
    },
    reclaimRisk,
  }
}

/** Periodically refreshes Oracle Cloud Always Free plan usage in memory every 15 minutes. */
export function createOracleUsage(
  oci: Pick<OciClient, 'isConfigured' | 'request'>,
  tenancyId: string | null,
  options: OracleUsageOptions = {},
): OracleUsageService {
  if (tenancyId === null || tenancyId.trim().length === 0 || !oci.isConfigured()) {
    return {
      snapshot: () => OFF_ORACLE_USAGE,
      refresh: async () => OFF_ORACLE_USAGE,
      close: () => {},
    }
  }

  const now = options.now ?? Date.now
  const intervalMs = options.refreshIntervalMs ?? ORACLE_REFRESH_INTERVAL_MS
  const timeoutMs = options.requestTimeoutMs ?? ORACLE_REQUEST_TIMEOUT_MS
  const log = options.log ?? ((message: string) => console.error(message))

  let lastUsage: OraclePlanUsage | null = null
  let lastAsOf: string | null = null
  let lastError: string | null = null
  let state: OracleUsageState = 'ok'
  let pending: Promise<OracleUsageSnapshot> | null = null

  const currentSnapshot = (): OracleUsageSnapshot => ({
    state,
    asOf: lastAsOf,
    error: lastError,
    warnings: lastUsage === null ? [] : evaluateOracleWarnings(lastUsage),
    usage: lastUsage,
  })

  const refresh = async (): Promise<OracleUsageSnapshot> => {
    if (pending !== null) return pending
    pending = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      try {
        const timestampMs = now()
        const usage = await fetchOracleUsage(oci, tenancyId, timestampMs, controller.signal)
        lastUsage = usage
        lastAsOf = new Date(timestampMs).toISOString()
        lastError = null
        state = 'ok'
      } catch (error) {
        const reason = controller.signal.aborted ? 'TimeoutError' : safeOciReason(error)
        lastError = reason
        state = 'error'
        log(`oracle usage refresh failed: ${reason}`)
      } finally {
        clearTimeout(timer)
        pending = null
      }
      return currentSnapshot()
    })()
    return pending
  }

  void refresh()
  const timer = setInterval(() => void refresh(), intervalMs)
  timer.unref()

  return {
    snapshot: currentSnapshot,
    refresh,
    close(): void {
      clearInterval(timer)
    },
  }
}

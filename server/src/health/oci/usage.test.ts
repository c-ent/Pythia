import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALWAYS_FREE_LIMITS,
  combineOverallHealth,
  createOracleUsage,
  evaluateOracleWarnings,
  evaluateReclaimRisk,
  OFF_ORACLE_USAGE,
  ORACLE_REFRESH_INTERVAL_MS,
  OciHttpError,
  type OciClient,
  type OciRequestOptions,
  type OraclePlanUsage,
} from './index.js'

const TEST_TENANCY = 'ocid1.tenancy.oc1..aaaaaaaaba3pv6wkcr4jqae5f15p2b2m2yt2j6rx32uzr4h25vqstifsfdsq'
const TEST_COMPARTMENT = 'ocid1.compartment.oc1..aaaaaaaa1234567890subcompartment'
const TEST_INSTANCE_A1 = 'ocid1.instance.oc1.phx.aaaaaaaa1111111111a1'
const TEST_INSTANCE_E2 = 'ocid1.instance.oc1.phx.aaaaaaaa2222222222e2'

interface StubState {
  compartments?: Array<{ id: string; lifecycleState: string }>
  availabilityDomains?: Array<{ name: string }>
  instancesByCompartment?: Record<string, Array<{ id: string; shape: string; lifecycleState: string; shapeConfig?: { ocpus: number; memoryInGBs: number } }>>
  volumesByCompartment?: Record<string, Array<{ sizeInGBs: number; lifecycleState: string }>>
  bootVolumesByKey?: Record<string, Array<{ sizeInGBs: number; lifecycleState: string }>>
  volumeBackupsByCompartment?: Record<string, Array<{ lifecycleState: string }>>
  bootVolumeBackupsByCompartment?: Record<string, Array<{ lifecycleState: string }>>
  computeLimits?: Array<{ name: string; scopeType?: string; value: number }>
  storageLimits?: Array<{ name: string; scopeType?: string; value: number }>
  cpuPoints?: Array<{ timestamp: string; value: number }>
  memoryPoints?: Array<{ timestamp: string; value: number }>
  netComputePoints?: Array<{ timestamp: string; value: number }>
  netVcnPoints?: Array<{ timestamp: string; value: number }>
  monthComputePoints?: Array<{ timestamp: string; value: number }>
  monthVcnPoints?: Array<{ timestamp: string; value: number }>
  costItems?: Array<{ computedAmount: number; currency: string }>
  failOn?: (options: OciRequestOptions) => Error | null
}

function makeStubOci(getState: () => StubState) {
  const requests: OciRequestOptions[] = []
  const requestSpy = vi.fn(async (options: OciRequestOptions): Promise<unknown> => {
    requests.push(options)
    const state = getState()
    const err = state.failOn?.(options)
    if (err) throw err

    if (options.service === 'identity' && options.path === '/20160918/compartments') {
      return state.compartments ?? []
    }
    if (options.service === 'identity' && options.path === '/20160918/availabilityDomains') {
      return state.availabilityDomains ?? [{ name: 'Uocm:PHX-AD-1' }]
    }
    if (options.service === 'limits' && options.path === '/20190729/limitValues') {
      if (options.query?.serviceName === 'compute-core') {
        return (
          state.computeLimits ?? [
            { name: 'standard-a1-core-count', scopeType: 'AD', value: 4 },
            { name: 'standard-a1-memory-count', scopeType: 'AD', value: 24 },
          ]
        )
      }
      return (
        state.storageLimits ?? [
          { name: 'total-storage-gb', scopeType: 'AD', value: 200 },
          { name: 'volume-backup-count', scopeType: 'REGION', value: 5 },
        ]
      )
    }
    if (options.service === 'limits' && options.path.endsWith('/resourceAvailability')) {
      throw new OciHttpError(404)
    }
    if (options.service === 'iaas' && options.path === '/20160918/instances') {
      const comp = options.query?.compartmentId ?? ''
      return state.instancesByCompartment?.[comp] ?? []
    }
    if (options.service === 'iaas' && options.path === '/20160918/volumes') {
      const comp = options.query?.compartmentId ?? ''
      return state.volumesByCompartment?.[comp] ?? []
    }
    if (options.service === 'iaas' && options.path === '/20160918/bootVolumes') {
      const key = `${options.query?.compartmentId ?? ''}|${options.query?.availabilityDomain ?? ''}`
      return state.bootVolumesByKey?.[key] ?? []
    }
    if (options.service === 'iaas' && options.path === '/20160918/volumeBackups') {
      const comp = options.query?.compartmentId ?? ''
      return state.volumeBackupsByCompartment?.[comp] ?? []
    }
    if (options.service === 'iaas' && options.path === '/20160918/bootVolumeBackups') {
      const comp = options.query?.compartmentId ?? ''
      return state.bootVolumeBackupsByCompartment?.[comp] ?? []
    }
    if (options.service === 'telemetry' && options.path === '/20180401/metrics/actions/summarizeMetricsData') {
      const body = options.body as { namespace: string; query: string; startTime: string; endTime: string }
      const startMs = Date.parse(body.startTime)
      const endMs = Date.parse(body.endTime)
      const isSevenDays = Math.abs(endMs - startMs - 7 * 24 * 60 * 60 * 1000) < 60_000
      if (body.namespace === 'oci_computeagent' && body.query.startsWith('CpuUtilization')) {
        return [{ aggregatedDatapoints: state.cpuPoints ?? [] }]
      }
      if (body.namespace === 'oci_computeagent' && body.query.startsWith('MemoryUtilization')) {
        return [{ aggregatedDatapoints: state.memoryPoints ?? [] }]
      }
      if (body.namespace === 'oci_computeagent' && body.query.startsWith('NetworksBytesOut')) {
        return [{ aggregatedDatapoints: isSevenDays ? (state.netComputePoints ?? []) : (state.monthComputePoints ?? []) }]
      }
      if (body.namespace === 'oci_vcn' && body.query.startsWith('VnicToNetworkBytes')) {
        return [{ aggregatedDatapoints: isSevenDays ? (state.netVcnPoints ?? []) : (state.monthVcnPoints ?? []) }]
      }
    }
    if (options.service === 'usageapi' && options.path === '/20200107/usage') {
      return { items: state.costItems ?? [{ computedAmount: 0, currency: 'USD' }] }
    }
    throw new Error(`Unexpected OCI request: ${options.service} ${options.path}`)
  })
  const client: Pick<OciClient, 'isConfigured' | 'request'> = {
    isConfigured: () => true,
    request: requestSpy as unknown as OciClient['request'],
  }
  return { client, requests }
}

function baseUsage(overrides: Partial<OraclePlanUsage> = {}): OraclePlanUsage {
  return {
    a1Ocpus: { used: 2, limit: 4 },
    a1MemoryGb: { used: 12, limit: 24 },
    blockStorageGb: { used: 100, limit: 200 },
    volumeBackups: { used: 2, limit: 5 },
    outboundDataBytes: { used: 500 * 1024 ** 3, limit: ALWAYS_FREE_LIMITS.outboundDataBytes },
    costThisMonth: { amount: 0, currency: 'USD' },
    reclaimRisk: { status: 'ok', cpuP95Percent: 35, networkPercent: 5, memoryPercent: 40, hasA1Instance: true },
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Oracle plan usage and warning health', () => {
  it('stays off and makes no requests when OCI is not configured', async () => {
    const requestSpy = vi.fn()
    const service = createOracleUsage({ isConfigured: () => false, request: requestSpy }, null)
    expect(service.snapshot()).toEqual(OFF_ORACLE_USAGE)
    expect(await service.refresh()).toEqual(OFF_ORACLE_USAGE)
    expect(requestSpy).not.toHaveBeenCalled()
    service.close()
  })

  it('aggregates tenancy A1 OCPUs/memory, block/boot storage, backups, outbound bytes, cost and reclaim metrics without leaking OCIDs', async () => {
    vi.useFakeTimers()
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0)
    vi.setSystemTime(nowMs)

    const stub: StubState = {
      compartments: [
        { id: TEST_COMPARTMENT, lifecycleState: 'ACTIVE' },
        { id: 'ocid1.compartment.oc1..deleted', lifecycleState: 'DELETED' },
      ],
      instancesByCompartment: {
        [TEST_TENANCY]: [
          { id: TEST_INSTANCE_A1, shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING', shapeConfig: { ocpus: 2, memoryInGBs: 12 } },
          { id: 'ocid1.instance.oc1.phx.terminated', shape: 'VM.Standard.A1.Flex', lifecycleState: 'TERMINATED', shapeConfig: { ocpus: 4, memoryInGBs: 24 } },
        ],
        [TEST_COMPARTMENT]: [
          { id: TEST_INSTANCE_E2, shape: 'VM.Standard.E2.1.Micro', lifecycleState: 'RUNNING', shapeConfig: { ocpus: 1, memoryInGBs: 1 } },
        ],
      },
      volumesByCompartment: {
        [TEST_TENANCY]: [{ sizeInGBs: 60, lifecycleState: 'AVAILABLE' }],
        [TEST_COMPARTMENT]: [{ sizeInGBs: 20, lifecycleState: 'TERMINATED' }],
      },
      bootVolumesByKey: {
        [`${TEST_TENANCY}|Uocm:PHX-AD-1`]: [{ sizeInGBs: 50, lifecycleState: 'AVAILABLE' }],
        [`${TEST_COMPARTMENT}|Uocm:PHX-AD-1`]: [{ sizeInGBs: 40, lifecycleState: 'AVAILABLE' }],
      },
      volumeBackupsByCompartment: {
        [TEST_TENANCY]: [{ lifecycleState: 'AVAILABLE' }],
      },
      bootVolumeBackupsByCompartment: {
        [TEST_COMPARTMENT]: [{ lifecycleState: 'AVAILABLE' }, { lifecycleState: 'FAULTY' }],
      },
      cpuPoints: [
        { timestamp: '2026-11-28T10:00:00Z', value: 25 },
        { timestamp: '2026-11-28T11:00:00Z', value: 42 },
      ],
      memoryPoints: [
        { timestamp: '2026-11-28T10:00:00Z', value: 55 },
        { timestamp: '2026-11-28T11:00:00Z', value: 60 },
      ],
      netVcnPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 2 * 125_000_000 * 3600 * 0.05 }],
      monthVcnPoints: [
        { timestamp: '2026-11-01T00:00:00Z', value: 500_000_000 },
        { timestamp: '2026-11-28T00:00:00Z', value: 700_000_000 },
      ],
      costItems: [{ computedAmount: 0, currency: 'USD' }],
    }

    const { client } = makeStubOci(() => stub)
    const service = createOracleUsage(client, TEST_TENANCY, { now: () => nowMs })
    const snapshot = await service.refresh()
    service.close()

    expect(snapshot.state).toBe('ok')
    expect(snapshot.error).toBeNull()
    expect(snapshot.asOf).toBe(new Date(nowMs).toISOString())
    expect(snapshot.warnings).toEqual([])
    expect(snapshot.usage).toEqual({
      a1Ocpus: { used: 2, limit: 4 },
      a1MemoryGb: { used: 12, limit: 24 },
      blockStorageGb: { used: 150, limit: 200 },
      volumeBackups: { used: 2, limit: 5 },
      outboundDataBytes: { used: 1_200_000_000, limit: ALWAYS_FREE_LIMITS.outboundDataBytes },
      costThisMonth: { amount: 0, currency: 'USD' },
      reclaimRisk: {
        status: 'ok',
        cpuP95Percent: 42,
        networkPercent: expect.any(Number),
        memoryPercent: 60,
        hasA1Instance: true,
      },
    })
    expect(combineOverallHealth('ok', snapshot)).toBe('ok')

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('ocid1.')
    expect(serialized).not.toContain(TEST_TENANCY)
    expect(serialized).not.toContain(TEST_COMPARTMENT)
    expect(serialized).not.toContain(TEST_INSTANCE_A1)
  })

  it('triggers warning when any meter reaches 90% or cost is above $0', () => {
    expect(evaluateOracleWarnings(baseUsage())).toEqual([])
    expect(evaluateOracleWarnings(baseUsage({ a1Ocpus: { used: 3.5, limit: 4 } }))).toEqual([])
    expect(evaluateOracleWarnings(baseUsage({ a1Ocpus: { used: 3.6, limit: 4 } }))).toEqual(['a1_ocpus_high'])
    expect(evaluateOracleWarnings(baseUsage({ a1MemoryGb: { used: 21.6, limit: 24 } }))).toEqual(['a1_memory_high'])
    expect(evaluateOracleWarnings(baseUsage({ blockStorageGb: { used: 180, limit: 200 } }))).toEqual(['block_storage_high'])
    expect(evaluateOracleWarnings(baseUsage({ volumeBackups: { used: 4.5, limit: 5 } }))).toEqual(['volume_backups_high'])
    expect(
      evaluateOracleWarnings(
        baseUsage({ outboundDataBytes: { used: Math.ceil(ALWAYS_FREE_LIMITS.outboundDataBytes * 0.9), limit: ALWAYS_FREE_LIMITS.outboundDataBytes } }),
      ),
    ).toEqual(['outbound_data_high'])
    expect(evaluateOracleWarnings(baseUsage({ costThisMonth: { amount: 0.01, currency: 'USD' } }))).toEqual(['cost_above_zero'])

    const warningSnap = { state: 'ok' as const, asOf: '2026-11-28T00:00:00.000Z', error: null, warnings: ['block_storage_high' as const], usage: baseUsage({ blockStorageGb: { used: 180, limit: 200 } }) }
    expect(combineOverallHealth('ok', warningSnap)).toBe('warning')
    expect(combineOverallHealth('broken', warningSnap)).toBe('broken')
  })

  it('flags reclaim risk as at_risk when all three 7-day values are under 20%', async () => {
    vi.useFakeTimers()
    const nowMs = Date.UTC(2026, 10, 28, 12, 0, 0)
    vi.setSystemTime(nowMs)

    const stub: StubState = {
      instancesByCompartment: {
        [TEST_TENANCY]: [
          { id: TEST_INSTANCE_A1, shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING', shapeConfig: { ocpus: 2, memoryInGBs: 12 } },
        ],
      },
      cpuPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 12.5 }],
      memoryPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 18.2 }],
      // 1% of 2 Gbps (250_000_000 B/s) over 1 hour
      netVcnPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 250_000_000 * 3600 * 0.01 }],
    }

    const { client } = makeStubOci(() => stub)
    const service = createOracleUsage(client, TEST_TENANCY, { now: () => nowMs })
    const snapshot = await service.refresh()
    service.close()

    expect(snapshot.usage?.reclaimRisk).toEqual({
      status: 'at_risk',
      cpuP95Percent: 12.5,
      networkPercent: 1,
      memoryPercent: 18.2,
      hasA1Instance: true,
    })
    expect(snapshot.warnings).toContain('reclaim_at_risk')
    expect(combineOverallHealth('ok', snapshot)).toBe('warning')

    expect(
      evaluateReclaimRisk({
        cpuP95Percent: 19.9,
        networkPercent: 19.9,
        memoryPercent: 20,
        hasA1Instance: true,
        instanceCount: 1,
      }).status,
    ).toBe('ok')
  })

  it('refreshes every 15 minutes in the background and keeps the last good values on failure', async () => {
    vi.useFakeTimers()
    let nowMs = Date.UTC(2026, 10, 28, 12, 0, 0)
    vi.setSystemTime(nowMs)

    let shouldFail = false
    const stub: StubState = {
      instancesByCompartment: {
        [TEST_TENANCY]: [
          { id: TEST_INSTANCE_A1, shape: 'VM.Standard.A1.Flex', lifecycleState: 'RUNNING', shapeConfig: { ocpus: 2, memoryInGBs: 12 } },
        ],
      },
      volumesByCompartment: {
        [TEST_TENANCY]: [{ sizeInGBs: 180, lifecycleState: 'AVAILABLE' }],
      },
      cpuPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 35 }],
      memoryPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 45 }],
      netVcnPoints: [{ timestamp: '2026-11-28T11:00:00Z', value: 250_000_000 * 3600 * 0.3 }],
      failOn: () => (shouldFail ? new OciHttpError(429) : null),
    }

    const log = vi.fn()
    const { client } = makeStubOci(() => stub)
    const service = createOracleUsage(client, TEST_TENANCY, { now: () => nowMs, log })

    // Initial startup refresh
    await vi.advanceTimersByTimeAsync(0)
    const initial = service.snapshot()
    const firstAsOf = new Date(nowMs).toISOString()
    expect(initial.state).toBe('ok')
    expect(initial.asOf).toBe(firstAsOf)
    expect(initial.usage?.blockStorageGb).toEqual({ used: 180, limit: 200 })
    expect(initial.warnings).toEqual(['block_storage_high'])

    // Advance 15 minutes with Oracle failing (429): last good values and asOf are preserved
    shouldFail = true
    nowMs += ORACLE_REFRESH_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(ORACLE_REFRESH_INTERVAL_MS)
    const failed = service.snapshot()
    expect(failed.state).toBe('error')
    expect(failed.error).toBe('Http429')
    expect(failed.asOf).toBe(firstAsOf)
    expect(failed.usage?.blockStorageGb).toEqual({ used: 180, limit: 200 })
    expect(failed.warnings).toEqual(['block_storage_high'])
    expect(log).toHaveBeenCalledWith('oracle usage refresh failed: Http429')

    // Next 15-minute cycle succeeds and updates asOf + clears error
    shouldFail = false
    stub.volumesByCompartment = {
      [TEST_TENANCY]: [{ sizeInGBs: 100, lifecycleState: 'AVAILABLE' }],
    }
    nowMs += ORACLE_REFRESH_INTERVAL_MS
    await vi.advanceTimersByTimeAsync(ORACLE_REFRESH_INTERVAL_MS)
    const recovered = service.snapshot()
    expect(recovered.state).toBe('ok')
    expect(recovered.error).toBeNull()
    expect(recovered.asOf).toBe(new Date(nowMs).toISOString())
    expect(recovered.usage?.blockStorageGb).toEqual({ used: 100, limit: 200 })
    expect(recovered.warnings).toEqual([])

    service.close()
  })
})

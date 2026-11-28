import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OFF_ORACLE_USAGE, type OracleUsageSnapshot } from '../../api/serverStatus'
import { ServerSection } from './ServerSection'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const BYTES_PER_10_TB = 10 * 1024 ** 4

function okOracleUsage(overrides: Partial<OracleUsageSnapshot> = {}): OracleUsageSnapshot {
  return {
    state: 'ok',
    asOf: '2026-11-28T00:05:00.000Z',
    error: null,
    warnings: [],
    usage: {
      a1Ocpus: { used: 2, limit: 4 },
      a1MemoryGb: { used: 12, limit: 24 },
      blockStorageGb: { used: 100, limit: 200 },
      volumeBackups: { used: 2, limit: 5 },
      outboundDataBytes: { used: 500 * 1024 ** 3, limit: BYTES_PER_10_TB },
      costThisMonth: { amount: 0, currency: 'USD' },
      reclaimRisk: {
        status: 'ok',
        cpuP95Percent: 34.5,
        networkPercent: 22,
        memoryPercent: 48.2,
        hasA1Instance: true,
      },
    },
    ...overrides,
  }
}

function serverDetails(oracle: OracleUsageSnapshot = OFF_ORACLE_USAGE) {
  return {
    sampledAt: '2026-11-28T00:00:00.000Z',
    checkedAt: '2026-11-28T00:01:00.000Z',
    health: oracle.warnings.length > 0 ? 'warning' : 'broken',
    cpu: { cores: 4, loadAverage: [0.1, 0.2, 0.3], busyPercent: 25 },
    memory: { totalBytes: 1000 * 1024 * 1024, availableBytes: 400 * 1024 * 1024, usedBytes: 600 * 1024 * 1024 },
    disk: { totalBytes: 10 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, usedBytes: 6 * 1024 ** 3 },
    databaseBytes: 12 * 1024,
    uptimeSeconds: { host: 90000, app: 3660 },
    version: { app: '1.2.3', commit: 'abc123' },
    checks: {
      postgres: { state: 'ok', reason: null },
      ollama: { state: 'broken', reason: 'TimeoutError', modelInstalled: true, modelLoaded: false, modelMemoryBytes: 0 },
      gemini: { state: 'off', reason: null },
      github: { state: 'ok', reason: null, remainingCore: 1234 },
      vault: { state: 'ok', reason: null },
      sources: { state: 'ok', reason: null, states: [{ id: 'obsidian', state: 'healthy', reason: null }] },
      oracle: { state: oracle.state === 'off' ? 'off' : oracle.state === 'error' ? 'broken' : 'ok', reason: oracle.error },
    },
    oracle,
  }
}

const offline = (isOnline: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(isOnline)

describe('ServerSection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, serverDetails())))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders host gauges, details, broken reasons, and Oracle setup steps when off', async () => {
    render(<ServerSection />)
    expect(await screen.findByRole('heading', { name: 'Host resources' })).toBeTruthy()
    expect(screen.getByRole('meter', { name: 'CPU used' }).getAttribute('aria-valuenow')).toBe('25')
    expect(screen.getByRole('meter', { name: 'Memory used' }).getAttribute('aria-valuenow')).toBe('60')
    expect(screen.getByRole('meter', { name: 'Disk used' }).getAttribute('aria-valuenow')).toBe('60')
    expect(screen.getByText(/Postgres database/)).toBeTruthy()
    expect(screen.getByText(/Host uptime/)).toBeTruthy()
    const ollama = screen.getByText('Ollama').closest('li')!
    expect(within(ollama).getByText(/TimeoutError/)).toBeTruthy()
    expect(within(ollama).getByText(/Model not loaded/)).toBeTruthy()
    expect(screen.getByText(/Checked/)).toBeTruthy()

    const oracleCard = screen.getByRole('region', { name: 'Oracle Cloud plan' })
    expect(within(oracleCard).getByText('Not set up')).toBeTruthy()
    expect(within(oracleCard).getByText(/Oracle Cloud Console/i)).toBeTruthy()
    expect(within(oracleCard).getByText('PYTHIA_OCI_TENANCY')).toBeTruthy()
    expect(within(oracleCard).getByText('/config/oci_api_key.pem')).toBeTruthy()
  })

  it('renders Oracle plan usage against limits, as-of time, and 7-day reclaim values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, serverDetails(okOracleUsage()))))
    render(<ServerSection />)

    const oracleCard = await screen.findByRole('region', { name: 'Oracle Cloud plan' })
    expect(within(oracleCard).getByText(/As of/)).toBeTruthy()
    expect(within(oracleCard).getByText('2 / 4')).toBeTruthy()
    expect(within(oracleCard).getByText('12 / 24 GB')).toBeTruthy()
    expect(within(oracleCard).getByText('100 / 200 GB')).toBeTruthy()
    expect(within(oracleCard).getByText('2 / 5')).toBeTruthy()
    expect(within(oracleCard).getByText('500 GB / 10 TB')).toBeTruthy()
    expect(within(oracleCard).getByText('$0.00')).toBeTruthy()
    expect(within(oracleCard).getByRole('meter', { name: 'Ampere A1 OCPUs used' }).getAttribute('aria-valuenow')).toBe('50')
    expect(within(oracleCard).getByRole('meter', { name: 'Block storage used' }).getAttribute('aria-valuenow')).toBe('50')

    expect(within(oracleCard).getByText('34.5%')).toBeTruthy()
    expect(within(oracleCard).getByText('22%')).toBeTruthy()
    expect(within(oracleCard).getByText('48.2%')).toBeTruthy()
  })

  it('shows at risk and warnings when reclaim risk is at_risk or limits/cost warn', async () => {
    const warningOracle = okOracleUsage({
      warnings: ['block_storage_high', 'cost_above_zero', 'reclaim_at_risk'],
      usage: {
        a1Ocpus: { used: 2, limit: 4 },
        a1MemoryGb: { used: 12, limit: 24 },
        blockStorageGb: { used: 184, limit: 200 },
        volumeBackups: { used: 2, limit: 5 },
        outboundDataBytes: { used: 1_000_000_000, limit: BYTES_PER_10_TB },
        costThisMonth: { amount: 1.25, currency: 'USD' },
        reclaimRisk: {
          status: 'at_risk',
          cpuP95Percent: 12.5,
          networkPercent: 1,
          memoryPercent: 18.2,
          hasA1Instance: true,
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, serverDetails(warningOracle))))
    render(<ServerSection />)

    const oracleCard = await screen.findByRole('region', { name: 'Oracle Cloud plan' })
    expect(within(oracleCard).getByText('Warning')).toBeTruthy()
    expect(within(oracleCard).getByText('184 / 200 GB')).toBeTruthy()
    expect(within(oracleCard).getByText('$1.25')).toBeTruthy()
    expect(within(oracleCard).getByText('Above $0 on Always Free')).toBeTruthy()
    expect(within(oracleCard).getByText(/at risk/i)).toBeTruthy()
    expect(within(oracleCard).getByText('12.5%')).toBeTruthy()
    expect(within(oracleCard).getByText('1%')).toBeTruthy()
    expect(within(oracleCard).getByText('18.2%')).toBeTruthy()
  })

  it('keeps showing last good Oracle values with as-of when refresh fails', async () => {
    const erroredOracle = okOracleUsage({
      state: 'error',
      error: 'Http429',
    })
    vi.stubGlobal('fetch', vi.fn(async () => json(200, serverDetails(erroredOracle))))
    render(<ServerSection />)

    const oracleCard = await screen.findByRole('region', { name: 'Oracle Cloud plan' })
    expect(within(oracleCard).getByText('Error')).toBeTruthy()
    expect(within(oracleCard).getByText(/Http429/)).toBeTruthy()
    expect(within(oracleCard).getByText(/Showing the last good values/)).toBeTruthy()
    expect(within(oracleCard).getByText(/As of/)).toBeTruthy()
    expect(within(oracleCard).getByText('2 / 4')).toBeTruthy()
  })

  it('refreshes the server data when requested', async () => {
    const fetch = vi.mocked(globalThis.fetch)
    render(<ServerSection />)
    await screen.findByRole('heading', { name: 'Host resources' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('shows the offline message and does not fetch while offline', () => {
    const online = offline(false)
    render(<ServerSection />)
    expect(screen.getByText('Server details need a connection.')).toBeTruthy()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    online.mockRestore()
  })

  it('shows an error when the server details request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: { code: 'unavailable', message: 'unavailable' } })))
    render(<ServerSection />)
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t load server details')
  })
})

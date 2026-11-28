import { LoaderCircle, RefreshCw, Server, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  getServerStatusDetails,
  scanServerStorage,
  serverCheckLabel,
  type ProcessBreakdown,
  type ServerCheck,
  type ServerStatusDetails,
} from '../../api/serverStatus'
import { useOnline } from '../../hooks/useOnline'
import { formatBytes } from '../../offline/storage'
import { serverCheckDetails, serverCheckState } from '../../sources/serverCheckFormat'
import { OracleCard } from './OracleCard'
import { StorageCard } from './StorageCard'

const CARD = 'rounded-card border border-line bg-surface p-4'

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function formatLoad(load: number[]): string {
  return load.map((value) => value.toFixed(2)).join(' · ')
}

function utilization(used: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

function Meter({ label, value, detail, percent }: { label: string; value: string; detail: string; percent: number }) {
  return (
    <div className="rounded-control border border-line bg-canvas p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </div>
      <div
        role="meter"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-2 h-2 overflow-hidden rounded-full bg-raised"
      >
        <div className="h-full rounded-full bg-accent-ink transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted">{detail}</p>
    </div>
  )
}

function CheckRow({ name, check }: { name: string; check: ServerCheck }) {
  const state = serverCheckState(check)
  const Icon = state.Icon
  const details = serverCheckDetails(check)
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 border-b border-line py-3 last:border-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium">{serverCheckLabel(name)}</p>
        {details.length > 0 ? <p className="mt-0.5 text-sm text-muted">{details.join(' · ')}</p> : null}
      </div>
      <span className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 text-sm font-medium ${state.tone}`}>
        <Icon aria-hidden="true" className="size-4" />
        {state.label}
      </span>
    </li>
  )
}

type LoadState = 'loading' | 'ready' | 'error'

function processScopeLabel(processes: ProcessBreakdown): string {
  if (processes.scope === 'host') return `Sampling ${processes.totalCount} host processes`
  if (processes.scope === 'container') {
    return `Sampling ${processes.totalCount} container processes (enable pid: host to see all host processes)`
  }
  return 'Showing app process only (/proc unavailable on this host)'
}

/** Settings › Server (R21, T79, T83): host gauges, top CPU/memory consumers, storage breakdown, connection checks, and Oracle Cloud plan usage. */
export function ServerSection() {
  const online = useOnline()
  const [data, setData] = useState<ServerStatusDetails | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [scanningStorage, setScanningStorage] = useState(false)
  const [scanError, setScanError] = useState(false)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getServerStatusDetails(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        setData(next)
        setState('ready')
      },
      () => {
        if (!controller.signal.aborted) setState('error')
      },
    )
    return () => controller.abort()
  }, [online])

  const refresh = useCallback(async (): Promise<void> => {
    if (!online) return
    setRefreshing(true)
    try {
      const next = await getServerStatusDetails()
      setData(next)
      setState('ready')
    } catch {
      setState('error')
    } finally {
      setRefreshing(false)
    }
  }, [online])

  const scanStorage = useCallback(async (): Promise<void> => {
    if (!online) return
    setScanningStorage(true)
    setScanError(false)
    try {
      const storage = await scanServerStorage()
      setData((prev) => (prev === null ? prev : { ...prev, storage }))
    } catch {
      setScanError(true)
    } finally {
      setScanningStorage(false)
    }
  }, [online])

  if (!online) {
    return (
      <section aria-labelledby="server-heading" className={CARD}>
        <header className="flex items-center gap-2">
          <Server aria-hidden="true" className="size-4 text-muted" />
          <h2 id="server-heading" className="text-lg font-semibold">Server</h2>
        </header>
        <p role="status" className="mt-4 flex items-center gap-2 rounded-control border border-warning/40 bg-canvas px-3 py-3 text-sm text-warning">
          <WifiOff aria-hidden="true" className="size-4 shrink-0" />
          Server details need a connection.
        </p>
      </section>
    )
  }

  const initialLoading = state === 'loading' && data === null
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Server</h2>
          <p className="mt-0.5 text-sm text-muted">Host resources and connection checks.</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing || initialLoading}
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}
          Refresh
        </button>
      </header>

      {state === 'error' ? (
        <p role="alert" className="rounded-card border border-danger/30 bg-surface px-4 py-3 text-sm text-danger">
          Couldn’t load server details. Try Refresh.
        </p>
      ) : null}
      {initialLoading ? <p role="status" className="py-5 text-sm text-muted">Loading server details…</p> : null}

      {data === null ? null : (
        <>
          {state === 'ready' ? null : (
            <p role="status" className="rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
              Showing the last server details received. Refresh to try again.
            </p>
          )}
          <section className={`space-y-3 ${CARD}`} aria-labelledby="resources-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="resources-heading" className="text-base font-semibold">Host resources</h3>
              <p className="text-xs text-muted">CPU sampled <time dateTime={data.sampledAt}>{new Date(data.sampledAt).toLocaleString()}</time></p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Meter label="CPU" value={`${Math.round(data.cpu.busyPercent)}%`} percent={data.cpu.busyPercent} detail={`${data.cpu.cores} cores · load ${formatLoad(data.cpu.loadAverage)} (1, 5, 15 min)`} />
              <Meter label="Memory" value={`${Math.round(utilization(data.memory.usedBytes, data.memory.totalBytes))}%`} percent={utilization(data.memory.usedBytes, data.memory.totalBytes)} detail={`${formatBytes(data.memory.usedBytes)} used · ${formatBytes(data.memory.availableBytes)} available of ${formatBytes(data.memory.totalBytes)}`} />
              <Meter label="Disk" value={`${Math.round(utilization(data.disk.usedBytes, data.disk.totalBytes))}%`} percent={utilization(data.disk.usedBytes, data.disk.totalBytes)} detail={`${formatBytes(data.disk.usedBytes)} used · ${formatBytes(data.disk.freeBytes)} free of ${formatBytes(data.disk.totalBytes)}`} />
            </div>
            <dl className="grid gap-3 border-t border-line pt-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-muted">Postgres database</dt><dd className="mt-0.5 font-medium">{formatBytes(data.databaseBytes)}</dd></div>
              <div><dt className="text-muted">Host uptime</dt><dd className="mt-0.5 font-medium">{formatDuration(data.uptimeSeconds.host)}</dd></div>
              <div><dt className="text-muted">App uptime</dt><dd className="mt-0.5 font-medium">{formatDuration(data.uptimeSeconds.app)}</dd></div>
              <div><dt className="text-muted">Version</dt><dd className="mt-0.5 break-all font-mono text-xs">{data.version.app}{data.version.commit ? ` · ${data.version.commit}` : ''}</dd></div>
            </dl>
            {data.processes.totalCount > 0 ? (
              <div className="space-y-3 border-t border-line pt-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-sm font-semibold">Top CPU &amp; memory consumers</h4>
                  <p className="text-xs text-muted">{processScopeLabel(data.processes)}</p>
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-control border border-line bg-canvas p-3">
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Top CPU</h5>
                    <ul className="mt-2 divide-y divide-line">
                      {data.processes.topCpu.map((proc) => (
                        <li key={`cpu-${proc.pid}`} className="flex items-baseline justify-between gap-2 py-1.5 text-sm first:pt-0 last:pb-0">
                          <span className="min-w-0 truncate">
                            <span className="font-mono text-xs font-medium">{proc.name}</span>
                            <span className="ml-1.5 text-xs text-muted">PID {proc.pid}</span>
                          </span>
                          <span className="shrink-0 text-xs font-semibold tabular-nums">
                            {proc.cpuPercent.toFixed(1)}%
                            <span className="ml-1.5 font-normal text-muted">({formatBytes(proc.memoryBytes)})</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-control border border-line bg-canvas p-3">
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Top memory</h5>
                    <ul className="mt-2 divide-y divide-line">
                      {data.processes.topMemory.map((proc) => (
                        <li key={`mem-${proc.pid}`} className="flex items-baseline justify-between gap-2 py-1.5 text-sm first:pt-0 last:pb-0">
                          <span className="min-w-0 truncate">
                            <span className="font-mono text-xs font-medium">{proc.name}</span>
                            <span className="ml-1.5 text-xs text-muted">PID {proc.pid}</span>
                          </span>
                          <span className="shrink-0 text-xs font-semibold tabular-nums">
                            {formatBytes(proc.memoryBytes)}
                            {data.memory.totalBytes > 0 ? (
                              <span className="ml-1.5 font-normal text-muted">
                                ({Math.round(utilization(proc.memoryBytes, data.memory.totalBytes))}%)
                              </span>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <StorageCard
            storage={data.storage}
            diskTotalBytes={data.disk.totalBytes}
            scanning={scanningStorage}
            scanError={scanError}
            onScan={() => void scanStorage()}
          />

          <section className={CARD} aria-labelledby="checks-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="checks-heading" className="text-base font-semibold">Connection checks</h3>
              <p className="text-xs text-muted">Checked <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString()}</time></p>
            </div>
            <ul className="mt-1 divide-y divide-line">
              {Object.entries(data.checks).map(([name, check]) => <CheckRow key={name} name={name} check={check} />)}
            </ul>
          </section>

          <OracleCard oracle={data.oracle} />
        </>
      )}
    </div>
  )
}

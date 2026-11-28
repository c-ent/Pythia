import { HardDrive, LoaderCircle, RefreshCw } from 'lucide-react'
import type { StorageScanSnapshot } from '../../api/serverStatus'
import { formatBytes } from '../../offline/storage'

const CARD = 'rounded-card border border-line bg-surface p-4'

function sharePercent(bytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0
  return Math.max(0, Math.min(100, (bytes / totalBytes) * 100))
}

/** Settings › Server, Storage breakdown and largest folders/files card (R21). */
export function StorageCard({
  storage,
  diskTotalBytes,
  scanning,
  scanError,
  onScan,
}: {
  storage: StorageScanSnapshot
  diskTotalBytes: number
  scanning: boolean
  scanError: boolean
  onScan: () => void
}) {
  const busy = scanning || storage.status === 'scanning'
  const hasData = storage.scannedAt !== null || storage.areas.length > 0

  return (
    <section className={`space-y-4 ${CARD}`} aria-labelledby="storage-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="storage-heading" className="text-base font-semibold">
            Storage breakdown
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {storage.scannedAt === null ? (
              busy ? 'Scanning host and Pythia storage…' : 'Refreshes every 15 minutes.'
            ) : (
              <>
                Scanned <time dateTime={storage.scannedAt}>{new Date(storage.scannedAt).toLocaleString()}</time> · Refreshes every 15 minutes
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onScan}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-canvas px-4 text-sm font-medium transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="size-4" />}
          Scan storage
        </button>
      </div>

      {scanError || storage.status === 'error' ? (
        <p
          role={hasData ? 'status' : 'alert'}
          className={
            hasData
              ? 'rounded-control border border-warning/40 bg-canvas px-3 py-2 text-sm text-warning'
              : 'rounded-control border border-danger/30 bg-canvas px-3 py-2 text-sm text-danger'
          }
        >
          Couldn’t finish storage scan{storage.error ? ` (${storage.error})` : ''}.
          {hasData ? ' Showing the last completed scan.' : ''}
        </p>
      ) : null}

      {!hasData ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <HardDrive aria-hidden="true" className="size-4 shrink-0" />
          {busy ? 'Scanning storage, database tables, and Ollama models…' : 'Press Scan storage to inspect folders and largest files.'}
        </p>
      ) : (
        <>
          {!storage.hostRootMounted ? (
            <p className="text-xs text-muted">
              Host root is not mounted in this container — showing Pythia folders, database tables, and Ollama models only.
            </p>
          ) : null}

          {storage.unreadableDirs > 0 ? (
            <p className="text-xs text-muted">
              {storage.unreadableDirs.toLocaleString()} root-owned host folder(s) (such as Docker internal volumes) could not be read from the app container. Pythia folders, database tables, and Ollama models below are measured directly.
            </p>
          ) : null}

          {storage.areas.length > 0 ? (
            <div>
              <h4 className="text-sm font-semibold">Pythia &amp; service storage</h4>
              <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {storage.areas.map((area) => (
                  <div key={area.id} className="rounded-control border border-line bg-canvas p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-medium">{area.label}</span>
                      <span className="text-sm font-semibold tabular-nums">
                        {area.bytes === null ? '—' : formatBytes(area.bytes)}
                      </span>
                    </div>
                    {area.path ? <p className="mt-1 truncate font-mono text-xs text-muted">{area.path}</p> : null}
                    {area.note ? <p className="mt-1 text-xs text-muted">{area.note}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {storage.hostTopDirs.length > 0 ? (
            <div className="border-t border-line pt-3">
              <h4 className="text-sm font-semibold">Host top-level folders</h4>
              <ul className="mt-2 space-y-2">
                {storage.hostTopDirs.map((entry) => {
                  const pct = sharePercent(entry.bytes, diskTotalBytes)
                  return (
                    <li key={entry.path} className="rounded-control border border-line bg-canvas px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate font-mono text-xs">{entry.path}</span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {formatBytes(entry.bytes)}
                          {diskTotalBytes > 0 ? <span className="ml-1.5 text-xs text-muted">({Math.round(pct)}%)</span> : null}
                        </span>
                      </div>
                      {diskTotalBytes > 0 ? (
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                          <div className="h-full rounded-full bg-accent-ink" style={{ width: `${pct}%` }} />
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          <div className="grid gap-4 border-t border-line pt-3 lg:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold">Largest folders</h4>
              {storage.largestDirs.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No folder sizes recorded.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-control border border-line bg-canvas">
                  {storage.largestDirs.map((entry) => (
                    <li key={entry.path} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 break-all font-mono text-xs">{entry.path}</span>
                      <span className="shrink-0 font-medium tabular-nums">{formatBytes(entry.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h4 className="text-sm font-semibold">Largest files</h4>
              {storage.largestFiles.length === 0 ? (
                <p className="mt-2 text-xs text-muted">No files recorded.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-control border border-line bg-canvas">
                  {storage.largestFiles.map((entry) => (
                    <li key={entry.path} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 break-all font-mono text-xs">{entry.path}</span>
                      <span className="shrink-0 font-medium tabular-nums">{formatBytes(entry.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {storage.databaseTables.length > 0 || storage.ollamaModels.length > 0 ? (
            <div className="grid gap-4 border-t border-line pt-3 lg:grid-cols-2">
              <div>
                <h4 className="text-sm font-semibold">Postgres tables</h4>
                {storage.databaseTables.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">No table sizes recorded.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-line rounded-control border border-line bg-canvas">
                    {storage.databaseTables.map((table) => (
                      <li key={table.name} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate font-mono text-xs">{table.name}</span>
                        <span className="shrink-0 font-medium tabular-nums">{formatBytes(table.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h4 className="text-sm font-semibold">Ollama models</h4>
                {storage.ollamaModels.length === 0 ? (
                  <p className="mt-2 text-xs text-muted">No Ollama models installed or Ollama unreachable.</p>
                ) : (
                  <ul className="mt-2 divide-y divide-line rounded-control border border-line bg-canvas">
                    {storage.ollamaModels.map((model) => (
                      <li key={model.name} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate font-mono text-xs">{model.name}</span>
                        <span className="shrink-0 text-xs font-medium tabular-nums">
                          {formatBytes(model.diskBytes)} disk
                          {model.memoryBytes > 0 ? ` · ${formatBytes(model.memoryBytes)} RAM` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

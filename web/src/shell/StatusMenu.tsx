import { Check, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { getServerStatusDetails, serverCheckLabel, type ServerStatusDetails } from '../api/serverStatus'
import { STATUS_CHANGED, type ServerHealth } from '../api/status'
import { followLink, settingsPath } from '../router'
import { serverCheckDetails, serverCheckState } from '../sources/serverCheckFormat'
import { usePopoverDismiss } from './usePopoverDismiss'

export interface StatusMenuProps {
  online: boolean
  reachable?: boolean
  health?: ServerHealth
  brokenChecks?: readonly string[]
  gemini?: boolean
  checkedAt?: string
}

interface Summary {
  label: string
  accessibleLabel: string
  dotClass: string
}

function statusSummary({ online, reachable, health, brokenChecks = [] }: StatusMenuProps): Summary {
  if (!online) {
    return { label: 'Offline', accessibleLabel: 'Status: Offline', dotClass: 'bg-warning' }
  }
  if (reachable === false) {
    return { label: 'Server unreachable', accessibleLabel: 'Status: Server unreachable', dotClass: 'bg-warning' }
  }
  if (health === 'broken') {
    const detail = brokenChecks.length > 0 ? `: ${brokenChecks.join(', ')}` : ''
    return { label: 'Server issue', accessibleLabel: `Server issue${detail}`, dotClass: 'bg-danger' }
  }
  if (health === 'warning') {
    return { label: 'Warning', accessibleLabel: 'Status: Warning', dotClass: 'bg-warning' }
  }
  return { label: 'Online', accessibleLabel: 'Status: Online', dotClass: 'bg-success' }
}

/**
 * Single top-bar status indicator combining device connectivity, server reachability,
 * server health, and API key checks. Clicking opens a popover with all live checks.
 */
export function StatusMenu(props: StatusMenuProps) {
  const { online, reachable, gemini, checkedAt } = props
  const [open, setOpen] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [fetched, setFetched] = useState<{
    requestKey: string
    details: ServerStatusDetails | null
    error: boolean
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const headingId = useId()
  const summary = statusSummary(props)
  const canQueryServer = online && reachable !== false
  const requestKey = `${checkedAt ?? ''}:${refreshTick}`
  const loading = open && canQueryServer && (fetched === null || fetched.requestKey !== requestKey)
  const details = fetched?.details ?? null
  const error = fetched?.requestKey === requestKey && fetched.error

  const close = useCallback((restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open || !canQueryServer) return
    const controller = new AbortController()
    getServerStatusDetails(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setFetched({ requestKey, details: next, error: false })
      },
      () => {
        if (!controller.signal.aborted) {
          setFetched((prev) => ({ requestKey, details: prev?.details ?? null, error: true }))
        }
      },
    )
    return () => controller.abort()
  }, [open, canQueryServer, requestKey])

  usePopoverDismiss(open, containerRef, close)

  const openRoute = (event: React.MouseEvent<HTMLAnchorElement>, path: string): void => {
    close(false)
    followLink(event, path)
  }

  const refresh = (): void => {
    setRefreshTick((n) => n + 1)
    window.dispatchEvent(new Event(STATUS_CHANGED))
  }

  const serverPath = settingsPath('server')
  const geminiPath = settingsPath('gemini')

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={summary.accessibleLabel}
        title={summary.accessibleLabel}
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-surface/75 px-3.5 text-sm text-ink transition-colors hover:bg-surface"
      >
        <span aria-hidden="true" className={`size-2 rounded-full ${summary.dotClass}`} />
        <span>{summary.label}</span>
      </button>

      {open ? (
        <section
          id={panelId}
          aria-labelledby={headingId}
          className="absolute top-full right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-4 text-ink shadow-[0_8px_24px_rgb(15_15_16/0.14)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className={`size-2.5 rounded-full ${summary.dotClass}`} />
              <h2 id={headingId} className="text-sm font-semibold">
                {summary.label}
              </h2>
            </div>
            {canQueryServer ? (
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                aria-label="Refresh status"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                )}
                Refresh
              </button>
            ) : null}
          </div>

          <ul className="mt-2 divide-y divide-line text-sm">
            <li className="flex items-center justify-between gap-3 py-2">
              <span className="font-medium">Pythia server</span>
              {!online ? (
                <span className="text-xs font-medium text-warning">Offline</span>
              ) : reachable === false ? (
                <span className="text-xs font-medium text-warning">Unreachable</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <Check aria-hidden="true" className="size-3.5" />
                  Online
                </span>
              )}
            </li>

            {canQueryServer && details !== null
              ? Object.entries(details.checks)
                  .filter(([name]) => name !== 'sources')
                  .map(([name, check]) => {
                    const state = serverCheckState(check)
                    const Icon = state.Icon
                    const info = serverCheckDetails(check)
                    return (
                      <li key={name} className="flex items-start justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <p className="font-medium">{serverCheckLabel(name)}</p>
                          {info.length > 0 ? <p className="text-xs text-muted">{info.join(' · ')}</p> : null}
                        </div>
                        <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${state.tone}`}>
                          <Icon aria-hidden="true" className="size-3.5" />
                          {state.label}
                        </span>
                      </li>
                    )
                  })
              : null}

            {canQueryServer && details === null && gemini !== undefined ? (
              <li className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium">Gemini</span>
                <span className={`text-xs font-medium ${gemini ? 'text-success' : 'text-muted'}`}>
                  {gemini ? 'Available' : 'Off'}
                </span>
              </li>
            ) : null}
          </ul>

          {!online ? (
            <p className="mt-2 rounded-control border border-warning/40 bg-canvas px-3 py-2 text-xs text-warning">
              You’re offline. Live server and key checks need a connection.
            </p>
          ) : reachable === false ? (
            <p className="mt-2 rounded-control border border-warning/40 bg-canvas px-3 py-2 text-xs text-warning">
              Can’t reach the server right now.
            </p>
          ) : (
            <>
              {loading && details === null ? (
                <p role="status" className="mt-2 text-xs text-muted">
                  Checking server and keys…
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                  Couldn’t load latest server and key checks.
                </p>
              ) : null}
              {details !== null && details.health === 'warning' ? (
                <p className="mt-2 rounded-control border border-warning/40 bg-canvas px-3 py-2 text-xs text-warning">
                  Oracle Cloud plan has a warning. Open Server details to review.
                </p>
              ) : null}
              {details !== null ? (
                <p className="mt-2 text-xs text-muted">
                  Checked <time dateTime={details.checkedAt}>{new Date(details.checkedAt).toLocaleTimeString()}</time>
                </p>
              ) : null}
            </>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
            <a
              href={serverPath}
              onClick={(event) => openRoute(event, serverPath)}
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-canvas px-3 text-xs font-medium text-ink transition-colors hover:bg-raised"
            >
              Server details
            </a>
            <a
              href={geminiPath}
              onClick={(event) => openRoute(event, geminiPath)}
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-line bg-canvas px-3 text-xs font-medium text-ink transition-colors hover:bg-raised"
            >
              Gemini access
            </a>
          </div>
        </section>
      ) : null}
    </div>
  )
}

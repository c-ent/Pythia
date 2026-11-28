import { Check, CircleAlert, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import { STATUS_CHANGED, type SourceHealth } from '../api/status'
import { followLink, pathFor } from '../router'
import { overallSyncPercent, sourceState, sourceTitle, type Tone } from '../sources/format'
import { usePopoverDismiss } from './usePopoverDismiss'

export interface SyncMenuProps {
  online: boolean
  reachable?: boolean
  sources?: readonly SourceHealth[]
  syncing?: boolean
}

interface SyncSummary {
  label: string
  accessibleLabel: string
  dotClass: string
  isSyncing: boolean
}

const TONE_CLASS: Record<Tone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-muted',
}

const TONE_ICON: Record<Tone, typeof Check> = {
  success: Check,
  danger: X,
  warning: CircleAlert,
  muted: CircleAlert,
}

function syncSummary(sources: readonly SourceHealth[], syncing: boolean): SyncSummary {
  const failed = sources.filter((source) => source.state === 'error' && !source.syncing)
  if (failed.length > 0) {
    const names = failed.map((source) => sourceTitle(source.id)).join(', ')
    return {
      label: 'Sync issue',
      accessibleLabel: `Sync issue: ${names}`,
      dotClass: 'bg-danger',
      isSyncing: false,
    }
  }
  if (syncing || sources.some((source) => source.syncing)) {
    const percent = overallSyncPercent(sources)
    const label = percent === null ? 'Syncing' : `Syncing ${percent}%`
    return {
      label,
      accessibleLabel: `Sync: ${label}`,
      dotClass: 'bg-accent',
      isSyncing: true,
    }
  }
  return {
    label: 'Synced',
    accessibleLabel: 'Sync: Synced',
    dotClass: 'bg-success',
    isSyncing: false,
  }
}

/**
 * Top-bar sync status pill showing source health independently of server health.
 * Clicking opens a popover listing each source's sync status and a link to Sources.
 */
export function SyncMenu({ online, reachable, sources, syncing = false }: SyncMenuProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const headingId = useId()

  const close = useCallback((restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }, [])

  usePopoverDismiss(open, containerRef, close)

  if (!online || reachable === false || sources === undefined) return null

  const summary = syncSummary(sources, syncing)
  const sourcesPath = pathFor('sources')

  const openSources = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    close(false)
    followLink(event, sourcesPath)
  }

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
        className="inline-flex min-h-11 items-center gap-2 rounded-full bg-surface/75 px-3 text-sm text-ink transition-colors hover:bg-surface md:px-3.5"
      >
        {summary.isSyncing ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted" />
        ) : (
          <span aria-hidden="true" className={`size-2 rounded-full ${summary.dotClass}`} />
        )}
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
              {summary.isSyncing ? (
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted" />
              ) : (
                <span aria-hidden="true" className={`size-2.5 rounded-full ${summary.dotClass}`} />
              )}
              <h2 id={headingId} className="text-sm font-semibold">
                {summary.label}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event(STATUS_CHANGED))}
              aria-label="Refresh sync status"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Refresh
            </button>
          </div>

          <ul className="mt-2 divide-y divide-line text-sm">
            {sources.map((source) => {
              const state = sourceState(source)
              const Icon = source.syncing ? LoaderCircle : TONE_ICON[state.tone]
              return (
                <li key={source.id} className="flex items-start justify-between gap-3 py-2">
                  <span className="font-medium">{sourceTitle(source.id)}</span>
                  <span className={`inline-flex shrink-0 items-center gap-1 text-right text-xs font-medium ${TONE_CLASS[state.tone]}`}>
                    <Icon aria-hidden="true" className={`size-3.5 ${source.syncing ? 'animate-spin' : ''}`} />
                    {state.label}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="mt-3 border-t border-line pt-3">
            <a
              href={sourcesPath}
              onClick={openSources}
              className="inline-flex min-h-11 w-full items-center justify-center rounded-control border border-line bg-canvas px-3 text-xs font-medium text-ink transition-colors hover:bg-raised"
            >
              Sources and sync
            </a>
          </div>
        </section>
      ) : null}
    </div>
  )
}

import {
  ChevronLeft,
  Cloud,
  FolderGit2,
  LoaderCircle,
  MessagesSquare,
  NotebookText,
  RefreshCw,
  RotateCw,
  StickyNote,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { statusChanged, type ActivityEvent, type ServerStatus, type SourceHealth } from '../api/status'
import { useOnline } from '../hooks/useOnline'
import { plural } from '../repos/format'
import { followLink, pathFor, settingsPath } from '../router'
import {
  activityText,
  formatWhen,
  sourceDetail,
  sourceState,
  sourceTitle,
  statusErrorText,
  type Tone,
} from '../sources/format'
import { KEEP_IMPORT_ID, KeepImport } from '../sources/KeepImport'
import { isSyncing, startSyncNow, useSyncNow } from '../sources/syncNow'
import { serverSyncing, useServerStatus } from '../sources/useServerStatus'

/** Activity rows shown before "Show all". */
export const ACTIVITY_PREVIEW = 8

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-muted',
}

const TONE_DOT: Record<Tone, string> = {
  success: 'bg-success',
  danger: 'bg-danger',
  warning: 'bg-warning',
  muted: 'bg-muted',
}

const SOURCE_ICONS: Record<SourceHealth['id'], LucideIcon> = {
  obsidian: NotebookText,
  github: FolderGit2,
  keep: StickyNote,
  gdrive: Cloud,
}

const BUTTON =
  'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:opacity-50 disabled:hover:bg-surface'

/**
 * Sources and sync (R18, ui.md): the Obsidian vault, GitHub repos, Google
 * Keep and Google Drive with health and last sync, Sync all, the Keep Takeout
 * import, chat history marked "Coming later", and recent activity.
 */
export function SourcesScreen() {
  const online = useOnline()
  const server = useServerStatus(online, { pollWhileSyncing: true })
  const sync = useSyncNow()
  const busy = isSyncing(sync) || serverSyncing(server.status)
  const status = server.status
  const nothingToSync =
    status !== null && status.sources.every((source) => source.kind === 'keep' || source.state === 'off')

  return (
    <>
      <a
        href={settingsPath('profile')}
        onClick={(event) => followLink(event, settingsPath('profile'))}
        className="-ml-2 mb-2 inline-flex min-h-11 items-center gap-1 rounded-control px-2 text-sm text-muted hover:text-ink md:hidden"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Settings
      </a>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Sources and sync</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">
            Everything Pythia reads. The index is read only; your originals are never changed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void startSyncNow()}
          disabled={!online || busy || nothingToSync}
          title={nothingToSync ? 'No vault or repos are configured on the server' : undefined}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control bg-strong px-4 text-sm font-medium text-on-strong transition-opacity hover:opacity-90 disabled:opacity-50 disabled:hover:opacity-50"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="size-4" />
          )}
          {busy ? 'Syncing…' : 'Sync all'}
        </button>
      </header>

      <div aria-live="polite" className="empty:hidden">
        {!online ? (
          <p className="mb-4 text-sm text-muted">You’re offline. Sync and source status need a connection.</p>
        ) : sync.phase === 'error' ? (
          <Alert message={sync.message} />
        ) : sync.phase === 'done' && !sync.serverFinished ? (
          <p className="mb-4 text-sm text-muted">The server is still syncing. This page updates when it is done.</p>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="sources-heading" className="min-w-0 space-y-3">
          <h2 id="sources-heading" className="sr-only">
            Sources
          </h2>
          <SourceList server={server} online={online} />
          <ChatHistoryCard />
        </section>

        <aside aria-label="Sync activity" className="min-w-0 space-y-4">
          <KeepImport online={online} onImported={statusChanged} />
          <ActivityPanel status={status} loading={server.loading} online={online} />
        </aside>
      </div>
    </>
  )
}

function SourceList({ server, online }: { server: ReturnType<typeof useServerStatus>; online: boolean }) {
  if (server.status === null) {
    if (!online) return <EmptyCard>Source status appears here once you’re back online.</EmptyCard>
    if (server.error !== null && !server.loading) {
      return <Alert message={statusErrorText(server.error)} onRetry={server.reload} />
    }
    return (
      <EmptyCard>
        <span className="inline-flex items-center gap-2">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading sources…
        </span>
      </EmptyCard>
    )
  }
  const { status } = server
  return (
    <>
      {server.error === null || !online ? null : (
        <Alert message={statusErrorText(server.error)} onRetry={server.reload} />
      )}
      {status.sources.map((source) => (
        <SourceCard key={source.id} source={source} status={status} />
      ))}
    </>
  )
}

function SourceCard({ source, status }: { source: SourceHealth; status: ServerStatus }) {
  const Icon = SOURCE_ICONS[source.id]
  const title = sourceTitle(source.id)
  const state = sourceState(source)
  const failing = source.id === 'github' ? status.repos.filter((repo) => repo.state === 'error') : []
  return (
    <article
      aria-label={title}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-line bg-surface p-4 shadow-[0_1px_2px_rgb(15_15_16/0.04)]"
    >
      <span
        aria-hidden="true"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control bg-accent text-on-accent"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-0.5 text-sm text-muted">{sourceDetail(source, status.repos.length)}</p>
        {failing.length === 0 ? null : (
          <p className="mt-1 text-sm text-danger">
            {plural(failing.length, 'repo')} failing:{' '}
            {failing
              .map((repo) => (repo.reason === null || repo.reason === '' ? repo.name : `${repo.name} (${repo.reason})`))
              .join(', ')}
          </p>
        )}
      </div>
      <span
        className={`inline-flex min-h-8 items-center gap-2 rounded-full bg-raised px-3 text-sm ${TONE_TEXT[state.tone]}`}
      >
        {source.syncing ? (
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <span aria-hidden="true" className={`size-2 rounded-full ${TONE_DOT[state.tone]}`} />
        )}
        {state.label}
      </span>
      <SourceAction source={source} />
    </article>
  )
}

function SourceAction({ source }: { source: SourceHealth }) {
  if (source.id === 'github' && source.state !== 'off') {
    const path = pathFor('repos')
    return (
      <a href={path} onClick={(event) => followLink(event, path)} className={BUTTON}>
        Manage
      </a>
    )
  }
  if (source.id === 'keep' && source.state !== 'off') {
    return (
      <button
        type="button"
        onClick={() => {
          const target = document.getElementById(KEEP_IMPORT_ID)
          target?.scrollIntoView?.({ block: 'start' })
          target?.querySelector<HTMLInputElement>('input[type="file"]')?.focus()
        }}
        className={BUTTON}
      >
        Import
      </button>
    )
  }
  return null
}

function ChatHistoryCard() {
  return (
    <article
      aria-label="Chat history"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-line bg-surface p-4"
    >
      <span
        aria-hidden="true"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control bg-raised text-muted"
      >
        <MessagesSquare className="size-5" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <h3 className="text-base font-semibold">Chat history</h3>
        <p className="mt-0.5 text-sm text-muted">Claude, ChatGPT and Gemini exports, added by importing their files.</p>
      </div>
      <span className="inline-flex min-h-8 items-center rounded-full bg-raised px-3 text-sm text-muted">
        Coming later
      </span>
    </article>
  )
}

function ActivityPanel({ status, loading, online }: { status: ServerStatus | null; loading: boolean; online: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const events = status?.activity ?? []
  const shown = expanded ? events : events.slice(0, ACTIVITY_PREVIEW)
  return (
    <section aria-labelledby="activity-heading" className="rounded-card border border-line bg-surface p-4">
      <h2 id="activity-heading" className="text-base font-semibold">
        Recent activity
      </h2>
      {status === null ? (
        <p className="mt-3 text-sm text-muted">
          {!online ? 'Activity needs a connection.' : loading ? 'Loading activity…' : 'Activity isn’t available.'}
        </p>
      ) : events.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Nothing yet. Syncs, imports and blocked secrets show here.</p>
      ) : (
        <>
          <ol aria-label="Activity" className="mt-3 space-y-3">
            {shown.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </ol>
          {events.length > ACTIVITY_PREVIEW ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
              className="mt-3 inline-flex min-h-11 items-center rounded-control px-2 text-sm font-medium text-accent-ink hover:bg-raised"
            >
              {expanded ? 'Show less' : `Show all ${events.length}`}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const { title, detail, tone } = activityText(event)
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted">
          {detail === '' ? null : `${detail} · `}
          <time dateTime={event.at}>{formatWhen(event.at)}</time>
        </p>
      </div>
    </li>
  )
}

function EmptyCard({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-line bg-surface p-4 text-sm text-muted">{children}</p>
}

function Alert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
        >
          <RotateCw aria-hidden="true" className="size-4" />
          Retry
        </button>
      )}
    </div>
  )
}

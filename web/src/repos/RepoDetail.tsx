import { Check, ChevronRight, FileText, FolderOpen, HardDriveDownload, LoaderCircle, Pin, PinOff, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { RepoInfo } from '../api/repos'
import type { RepoStatus } from '../api/repoSync'
import { documentPath, followLink, repoPath } from '../router'
import { timeAgo } from '../search/format'
import { formatDateTime, plural, SKIPPED_TEXT } from './format'
import { isSyncBusy, type AllowAskState, type OverviewEntry, type SyncEntry } from './state'
import { repoInitials, type LanguageShare, type RepoSummaryParts } from './summary'
import type { PinState } from './useCachedRepos'

// The Repos page's detail panel (T44): stats, languages, what is indexed,
// "Allow Ask to read this repo", Open overview, Re-sync and pin. ReposScreen
// owns the data; this only draws it.

export function RepoTile({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-control bg-accent font-semibold text-on-accent ${
        large ? 'size-12 text-base' : 'size-10 text-sm'
      }`}
    >
      {repoInitials(name)}
    </span>
  )
}

/** Cached (files on this device), Pinned (cached at the next offline sync) or Online only. */
export function PinBadge({ state }: { state: PinState }) {
  if (state === 'online') return <span className="text-xs text-muted">Online only</span>
  const Icon = state === 'cached' ? HardDriveDownload : Pin
  return (
    <span
      title={state === 'cached' ? 'Files kept on this device' : 'Kept on this device after the next offline sync'}
      className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-ink"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {state === 'cached' ? 'Cached' : 'Pinned'}
    </span>
  )
}

const SECTION_TITLE = 'text-xs font-semibold tracking-wide text-muted uppercase'
const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-4 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50'
const TREE_SHOWN = 8
const LANGUAGES_SHOWN = 3
const SEGMENT_COLORS = ['bg-accent', 'bg-strong', 'bg-muted', 'bg-line']

export interface RepoDetailProps {
  repo: RepoInfo
  headingId: string
  overview: OverviewEntry | undefined
  parts: RepoSummaryParts | null
  /** undefined: `GET /api/status` not read; null: the repo is not in it. */
  status: RepoStatus | null | undefined
  now: number
  timeZone: string
  online: boolean
  pinState: PinState
  onTogglePin: () => void
  allowAsk: AllowAskState
  onAllowAsk: (allowed: boolean) => void
  sync: SyncEntry | undefined
  onResync: () => void
  onRetryOverview: () => void
}

export function RepoDetail(props: RepoDetailProps) {
  const { repo, overview, parts, status, now, timeZone, sync } = props
  const summary = overview?.status === 'done' ? overview.overview.summary : null

  let overviewNote: ReactNode = null
  if (overview === undefined || overview.status === 'loading') {
    overviewNote = (
      <p aria-live="polite" className="mt-3 flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Loading details…
      </p>
    )
  } else if (overview.status === 'error') {
    overviewNote = (
      <div role="alert" className="mt-3 flex items-start gap-2 text-sm text-danger">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="flex-1">{overview.message}</span>
        <button
          type="button"
          onClick={props.onRetryOverview}
          className="-my-2.5 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
        >
          <RotateCw aria-hidden="true" className="size-4" />
          Retry
        </button>
      </div>
    )
  } else if (summary === null) {
    overviewNote = <p className="mt-3 text-sm text-muted">No overview yet. It appears after the first index run.</p>
  }

  let lastSynced: ReactNode = 'Unknown'
  if (status?.lastSyncAt != null) {
    lastSynced = <time dateTime={status.lastSyncAt}>{formatDateTime(status.lastSyncAt, timeZone)}</time>
  } else if (status !== undefined && status !== null) {
    lastSynced = 'Not yet'
  }

  return (
    <section
      aria-labelledby={props.headingId}
      className="rounded-card border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(15_15_16/0.05)]"
    >
      <div className="flex items-center gap-3">
        <RepoTile name={repo.name} large />
        <div className="min-w-0">
          <h2 id={props.headingId} tabIndex={-1} className="text-lg font-semibold break-all outline-none">
            <a
              href={repoPath(repo.name)}
              onClick={(event) => followLink(event, repoPath(repo.name))}
              className="inline-flex items-center gap-1 rounded-control transition-colors hover:text-accent-ink hover:underline"
            >
              <span>{repo.name}</span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
            </a>
          </h2>
          <p className="text-[0.8125rem] text-muted">
            {parts?.branch == null ? 'GitHub repo' : `GitHub repo · ${parts.branch}`}
          </p>
        </div>
      </div>
      {parts?.description == null ? null : <p className="mt-3 text-sm text-ink/80">{parts.description}</p>}
      {overviewNote}

      {parts !== null && parts.languages.length > 0 ? <Languages languages={parts.languages} /> : null}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 text-sm">
        <Stat label="Files indexed">{repo.files.toLocaleString('en-US')}</Stat>
        <Stat label="Chunks">{repo.chunks.toLocaleString('en-US')}</Stat>
        {parts?.firstCommitAt != null ? (
          <Stat label="First commit">
            <time dateTime={parts.firstCommitAt}>{formatDateTime(parts.firstCommitAt, timeZone)}</time>
          </Stat>
        ) : null}
        {parts?.lastCommitAt != null ? (
          <Stat label="Latest commit">
            <time dateTime={parts.lastCommitAt}>{timeAgo(parts.lastCommitAt, now, timeZone)}</time>
          </Stat>
        ) : null}
        <Stat label="Last change">
          {repo.updatedAt === null ? 'Not indexed yet' : <time dateTime={repo.updatedAt}>{timeAgo(repo.updatedAt, now, timeZone)}</time>}
        </Stat>
        <Stat label="Last synced">{lastSynced}</Stat>
      </dl>
      {sync?.phase !== 'failed' && status?.state === 'error' ? (
        <p className="mt-3 flex items-start gap-1.5 text-[0.8125rem] text-danger">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {status.reason === null ? 'The last sync failed.' : `The last sync failed (${status.reason}).`} The previous index is kept.
        </p>
      ) : null}
      {status?.state === 'off' ? <p className="mt-3 text-[0.8125rem] text-muted">Repo fetching is off on this server.</p> : null}

      <div className="mt-4 border-t border-line pt-4">
        <h3 className={SECTION_TITLE}>What is indexed</h3>
        {parts !== null && parts.tree.length > 0 ? <Tree repoName={repo.name} parts={parts} /> : null}
        <p className="mt-2 text-xs text-muted">{SKIPPED_TEXT}</p>
      </div>

      <AllowAsk state={props.allowAsk} online={props.online} onChange={props.onAllowAsk} />

      <Actions {...props} summaryId={summary?.documentId ?? null} />
      <SyncMessage name={repo.name} sync={sync} />
    </section>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function Languages({ languages }: { languages: readonly LanguageShare[] }) {
  const shown: Array<{ name: string; percent: number }> = languages.slice(0, LANGUAGES_SHOWN)
  if (languages.length > LANGUAGES_SHOWN) {
    const rest = 100 - shown.reduce((sum, language) => sum + language.percent, 0)
    if (rest > 0) shown.push({ name: 'Other', percent: rest })
  }
  const label = shown.map((language) => `${language.name} ${language.percent} percent`).join(', ')
  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className={SECTION_TITLE}>Languages</h3>
      <div role="img" aria-label={label} className="mt-2 flex h-2 overflow-hidden rounded-full bg-raised">
        {shown.map((language, index) =>
          language.percent > 0 ? (
            <span
              key={language.name}
              className={`h-full ${SEGMENT_COLORS[index] ?? 'bg-line'}`}
              style={{ width: `${language.percent}%` }}
            />
          ) : null,
        )}
      </div>
      <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {shown.map((language, index) => (
          <li key={language.name} className="inline-flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${SEGMENT_COLORS[index] ?? 'bg-line'}`} />
            {language.name} {language.percent}%
          </li>
        ))}
      </ul>
    </div>
  )
}

function Tree({ repoName, parts }: { repoName: string; parts: RepoSummaryParts }) {
  const more = Math.max(0, parts.tree.length - TREE_SHOWN) + parts.moreEntries
  return (
    <ul aria-label="Indexed folders and files" className="mt-2 flex flex-wrap gap-1.5">
      {parts.tree.slice(0, TREE_SHOWN).map((entry) => {
        const href =
          entry.files !== null
            ? repoPath(repoName, entry.name.replace(/\/+$/, ''))
            : `${repoPath(repoName)}?${new URLSearchParams({ q: entry.name }).toString()}`
        return (
          <li key={entry.name}>
            <a
              href={href}
              onClick={(event) => followLink(event, href)}
              className="inline-flex items-center rounded-full bg-raised px-2.5 py-1 font-mono text-xs break-all text-ink transition-colors hover:text-accent-ink hover:underline"
            >
              {entry.name}
              {entry.files === null ? null : <span className="text-muted"> · {plural(entry.files, 'file')}</span>}
            </a>
          </li>
        )
      })}
      {more > 0 ? (
        <li>
          <a
            href={repoPath(repoName)}
            onClick={(event) => followLink(event, repoPath(repoName))}
            className="inline-flex items-center rounded-full bg-raised px-2.5 py-1 text-xs text-muted transition-colors hover:text-accent-ink hover:underline"
          >
            +{more} more
          </a>
        </li>
      ) : null}
    </ul>
  )
}

function AllowAsk({ state, online, onChange }: { state: AllowAskState; online: boolean; onChange: (allowed: boolean) => void }) {
  const labelId = useId()
  const descriptionId = useId()
  const checked = state.state === 'ready' ? state.allowed : state.state === 'error' && state.allowed === true
  const disabled = !online || state.state !== 'ready' || state.saving
  let description: string
  if (state.state === 'loading') description = 'Checking the Gemini rules…'
  else if (state.state === 'error' && state.allowed === null) description = 'Unknown right now.'
  else if (checked) description = 'Sends snippets to Gemini when Ask uses it.'
  else description = 'Locked: its text never goes to Gemini.'
  const error = state.state === 'error' ? state.message : state.state === 'ready' ? state.error : null
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-sm font-medium">
            Allow Ask to read this repo
          </p>
          <p id={descriptionId} className="mt-0.5 text-[0.8125rem] text-muted">
            {description}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className="group inline-flex min-h-11 min-w-13 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="relative h-7 w-12 rounded-full bg-muted transition-colors duration-150 group-aria-checked:bg-strong motion-reduce:transition-none">
            <span className="absolute top-1 left-1 size-5 rounded-full bg-surface transition-transform duration-150 group-aria-checked:translate-x-5 motion-reduce:transition-none" />
          </span>
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="mt-2 text-[0.8125rem] text-danger">
          {error}
        </p>
      )}
      {online ? null : <p className="mt-2 text-[0.8125rem] text-muted">Changing this needs a connection.</p>}
    </div>
  )
}

function Actions({
  repo,
  online,
  pinState,
  onTogglePin,
  sync,
  onResync,
  summaryId,
}: RepoDetailProps & { summaryId: number | null }) {
  const busy = isSyncBusy(sync)
  const pinned = pinState !== 'online'
  const PinIcon = pinned ? PinOff : Pin
  const overviewPath = summaryId === null ? null : documentPath(summaryId)
  const filesPath = repoPath(repo.name)
  return (
    <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
      <a
        href={filesPath}
        onClick={(event) => followLink(event, filesPath)}
        className={`${BUTTON} flex-1 bg-strong text-on-strong hover:opacity-90`}
      >
        <FolderOpen aria-hidden="true" className="size-4" />
        View files
      </a>
      {overviewPath === null ? (
        <button type="button" disabled className={`${BUTTON} flex-1 border border-line bg-surface text-ink`}>
          <FileText aria-hidden="true" className="size-4" />
          Open overview
        </button>
      ) : (
        <a
          href={overviewPath}
          onClick={(event) => followLink(event, overviewPath)}
          className={`${BUTTON} flex-1 border border-line bg-surface text-ink hover:bg-raised`}
        >
          <FileText aria-hidden="true" className="size-4" />
          Open overview
        </a>
      )}
      <button
        type="button"
        onClick={onResync}
        disabled={!online || busy}
        className={`${BUTTON} flex-1 border border-line bg-surface text-ink hover:bg-raised`}
      >
        {busy ? (
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        ) : (
          <RefreshCw aria-hidden="true" className="size-4" />
        )}
        {busy ? 'Syncing…' : 'Re-sync'}
      </button>
      <button
        type="button"
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${repo.name}` : `Pin ${repo.name} for offline`}
        title={pinned ? 'Pinned: files kept on this device' : 'Pin for offline'}
        onClick={onTogglePin}
        className={`${BUTTON} border ${
          pinned ? 'border-accent bg-raised text-accent-ink' : 'border-line text-ink hover:bg-raised'
        }`}
      >
        <PinIcon aria-hidden="true" className="size-4" />
        {pinState === 'cached' ? 'Cached' : pinned ? 'Pinned' : 'Pin offline'}
      </button>
    </div>
  )
}

function SyncMessage({ name, sync }: { name: string; sync: SyncEntry | undefined }) {
  if (sync?.phase === 'failed') {
    return (
      <p role="alert" className="mt-3 flex items-start gap-1.5 text-[0.8125rem] text-danger">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {sync.message}
      </p>
    )
  }
  return (
    <div role="status" className="text-[0.8125rem]">
      {isSyncBusy(sync) ? <p className="mt-3 text-muted">Fetching and indexing {name}. This updates when it’s done.</p> : null}
      {sync?.phase === 'done' ? (
        <p className="mt-3 flex items-center gap-1.5 text-success">
          <Check aria-hidden="true" className="size-3.5" />
          Synced. The index is up to date.
        </p>
      ) : null}
    </div>
  )
}

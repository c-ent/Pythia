import { ChevronDown, FolderGit2, LoaderCircle, Lock, Pin, PinOff, RotateCw, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { getRepoOverview, listRepos, type RepoInfo, type RepoOverview } from '../api/repos'
import { Placeholder, ScreenHeader } from '../components/Screen'
import { useOnline } from '../hooks/useOnline'
import { formatDate, overviewErrorMessage, plural, repoListErrorMessage, REPOS_OFFLINE_MESSAGE } from '../repos/format'
import { setRepoPinned, usePinnedRepos } from '../repos/pins'

type ListState =
  | { status: 'loading' }
  | { status: 'done'; repos: RepoInfo[] }
  | { status: 'error'; message: string }

type OverviewState =
  | { status: 'loading' }
  | { status: 'done'; overview: RepoOverview }
  | { status: 'error'; message: string }

export function ReposScreen() {
  const online = useOnline()
  const pins = usePinnedRepos()
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [pinError, setPinError] = useState<string | null>(null)
  // Bumped by Retry; each value (and each return online) loads the list again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    listRepos(controller.signal)
      .then((repos) => {
        if (!controller.signal.aborted) setList({ status: 'done', repos: [...repos].sort((a, b) => a.name.localeCompare(b.name)) })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setList({ status: 'error', message: repoListErrorMessage(error) })
      })
    return () => controller.abort()
  }, [online, attempt])

  const load = (): void => {
    setList({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  const togglePin = (name: string, pinned: boolean): void => {
    setPinError(setRepoPinned(name, pinned) ? null : 'This browser refused to save the pin. Check its storage settings.')
  }

  return (
    <>
      <ScreenHeader title="Repos" description="Your personal GitHub repos. Pin one to keep its files on this device for offline search." />
      {pinError === null ? null : <Alert message={pinError} />}
      <RepoList state={online ? list : { status: 'error', message: REPOS_OFFLINE_MESSAGE }} pins={pins} onRetry={online ? load : undefined} onTogglePin={togglePin} />
    </>
  )
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

function RepoList({
  state,
  pins,
  onRetry,
  onTogglePin,
}: {
  state: ListState
  pins: readonly string[]
  onRetry?: () => void
  onTogglePin: (name: string, pinned: boolean) => void
}) {
  switch (state.status) {
    case 'loading':
      return (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading repos…
        </p>
      )
    case 'error':
      return <Alert message={state.message} onRetry={onRetry} />
    case 'done':
      if (state.repos.length === 0) {
        return (
          <Placeholder icon={FolderGit2} title="No repos indexed yet">
            Repos appear here once GitHub indexing is set up, with an overview and an offline pin for each.
          </Placeholder>
        )
      }
      return (
        <ul className="space-y-3">
          {state.repos.map((repo) => (
            <li key={repo.name}>
              <RepoCard repo={repo} pinned={pins.includes(repo.name)} onTogglePin={onTogglePin} />
            </li>
          ))}
        </ul>
      )
  }
}

function RepoCard({
  repo,
  pinned,
  onTogglePin,
}: {
  repo: RepoInfo
  pinned: boolean
  onTogglePin: (name: string, pinned: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<OverviewState | null>(null)
  const pending = useRef<AbortController | null>(null)
  const panelId = useId()

  useEffect(() => () => pending.current?.abort(), [])

  const loadOverview = (): void => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setOverview({ status: 'loading' })
    getRepoOverview(repo.name, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setOverview({ status: 'done', overview: result })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setOverview({ status: 'error', message: overviewErrorMessage(error) })
      })
  }

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    // Load once; a failed load retries on the next open.
    if (next && (overview === null || overview.status === 'error')) loadOverview()
  }

  const PinIcon = pinned ? PinOff : Pin

  return (
    <article className="rounded-card border border-line bg-surface">
      <div className="flex items-start gap-2 p-4">
        <FolderGit2 aria-hidden="true" className="mt-1 size-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-base font-medium break-all">{repo.name}</h2>
          <p className="mt-1 text-sm text-muted">
            {plural(repo.files, 'file')} · {plural(repo.chunks, 'chunk')}
            {repo.updatedAt === null ? (
              ' · not indexed yet'
            ) : (
              <>
                {' · updated '}
                <time dateTime={repo.updatedAt}>{formatDate(repo.updatedAt)}</time>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${repo.name}` : `Pin ${repo.name} for offline`}
          title={pinned ? 'Pinned: files kept on this device' : 'Pin for offline'}
          onClick={() => onTogglePin(repo.name, !pinned)}
          className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-control border px-3 text-sm transition-colors ${
            pinned ? 'border-accent bg-raised text-accent-ink' : 'border-line text-muted hover:bg-raised hover:text-ink'
          }`}
        >
          <PinIcon aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">{pinned ? 'Pinned' : 'Pin'}</span>
        </button>
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggleOpen}
        className="flex min-h-11 w-full items-center gap-2 border-t border-line px-4 text-left text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <ChevronDown aria-hidden="true" className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide overview' : 'Show overview'}
        <span className="sr-only"> for {repo.name}</span>
      </button>
      {open ? (
        <div id={panelId} className="border-t border-line px-4 py-3">
          <OverviewPanel state={overview} onRetry={loadOverview} />
        </div>
      ) : null}
    </article>
  )
}

function OverviewPanel({ state, onRetry }: { state: OverviewState | null; onRetry: () => void }) {
  if (state === null || state.status === 'loading') {
    return (
      <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Loading overview…
      </p>
    )
  }
  if (state.status === 'error') return <Alert message={state.message} onRetry={onRetry} />
  const { summary } = state.overview
  if (summary === null) return <p className="text-sm text-muted">No overview yet. It appears after the first index run.</p>
  return (
    <>
      {summary.allowLlm ? null : (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted">
          <Lock aria-hidden="true" className="size-3.5" />
          Local only: never sent to Gemini
        </p>
      )}
      <pre className="font-mono text-sm whitespace-pre-wrap text-ink">{summary.text}</pre>
    </>
  )
}

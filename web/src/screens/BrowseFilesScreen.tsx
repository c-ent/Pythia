import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Cloud,
  FileCode,
  FileText,
  Folder,
  FolderGit2,
  HardDrive,
  List,
  LoaderCircle,
  Lock,
  NotebookText,
  Pin,
  PinOff,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
  StickyNote,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { askQuestion } from '../api/ask'
import { ApiError } from '../api/client'
import type { DocumentInfo } from '../api/documents'
import { getRepoOverview, type RepoOverview } from '../api/repos'
import { getRepoStatuses, startRepoSync, type RepoStatus } from '../api/repoSync'
import { searchNotes, type SearchResponse, type SourceKind } from '../api/search'
import { useOnline } from '../hooks/useOnline'
import { searchOffline } from '../offline/offlineSearch'
import { useProfile } from '../profile/profile'
import {
  overviewErrorMessage,
  plural,
  resyncErrorMessage,
  SYNC_CHECK_FAILED_MESSAGE,
  SYNC_POLL_MS,
  syncFailedMessage,
} from '../repos/format'
import { setRepoPinned, usePinnedRepos } from '../repos/pins'
import { RepoTile } from '../repos/RepoDetail'
import { isSyncBusy, type SyncEntry } from '../repos/state'
import { parseRepoSummary } from '../repos/summary'
import { pinStateOf, useCachedRepos } from '../repos/useCachedRepos'
import { documentPath, followLink, navigate, pathFor, repoPath, sourceBrowsePath, useLocationSearch } from '../router'
import { AskAnswer, type AnswerState } from '../search/AskAnswer'
import { askErrorMessage, OFFLINE_MESSAGE, resultCount, SEARCH_LIMIT, searchErrorMessage, timeAgo } from '../search/format'
import { ResultCard } from '../search/ResultCard'
import { SOURCE_ICONS } from '../search/format'
import { sourceTitle } from '../sources/format'
import { loadFiles } from '../browse/loadFiles'
import { breadcrumbsFor, fileLabel, filterDocuments, folderSlice, hasFolders, normalizeFolder } from '../browse/tree'

type FilesLoadState =
  | { status: 'loading' }
  | { status: 'done'; documents: DocumentInfo[]; total: number; cached: boolean }
  | { status: 'error'; message: string }

type QueryMode = 'search' | 'ask'

type QueryOutcome =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; query: string; response: SearchResponse; offline: boolean }
  | { status: 'error'; query: string; message: string }

const OUTLINE_BUTTON =
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-control border border-line bg-surface px-3.5 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50'

const SOURCE_PAGE_ICON: Record<SourceKind, LucideIcon> = {
  obsidian: NotebookText,
  repo: FolderGit2,
  keep: StickyNote,
  gdrive: Cloud,
}

const SOURCE_PAGE_TITLE: Record<SourceKind, string> = {
  obsidian: sourceTitle('obsidian'),
  repo: sourceTitle('github'),
  keep: sourceTitle('keep'),
  gdrive: sourceTitle('gdrive'),
}

function filesErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  return 'Couldn’t load the files. Try again.'
}

function isCodeFile(doc: DocumentInfo): boolean {
  return doc.source.kind === 'repo' && !/\.(md|mdx|markdown|txt)$/i.test(doc.path)
}

/**
 * File browser with scoped Search and Ask for a single GitHub repo
 * (`/repos/<name>`) or an indexed source (`/sources/obsidian`, `/sources/keep`,
 * `/sources/gdrive`, `/sources/repo`).
 */
export function BrowseFilesScreen({
  source,
  repoName,
  pollMs = SYNC_POLL_MS,
}: {
  source: SourceKind
  repoName?: string
  pollMs?: number
}) {
  const online = useOnline()
  const { timeZone, notePreviews } = useProfile()
  const locationSearch = useLocationSearch()
  const [now] = useState(Date.now)
  const pins = usePinnedRepos()
  const cachedRepos = useCachedRepos(pins)

  const [filesState, setFilesState] = useState<FilesLoadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [overview, setOverview] = useState<RepoOverview | null>(null)
  const [overviewMissing, setOverviewMissing] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [repoStatus, setRepoStatus] = useState<RepoStatus | null>(null)
  const [sync, setSync] = useState<SyncEntry | undefined>(undefined)
  const [pollTick, setPollTick] = useState(0)
  const [pinError, setPinError] = useState<string | null>(null)

  const [fileFilterState, setFileFilterState] = useState<{ fromUrl: string; value: string }>(() => {
    const q = new URLSearchParams(window.location.search).get('q') ?? ''
    return { fromUrl: q, value: q }
  })
  const [viewMode, setViewMode] = useState<'folders' | 'all'>('folders')

  const [queryMode, setQueryMode] = useState<QueryMode>('search')
  const [queryText, setQueryText] = useState('')
  const [queryOutcome, setQueryOutcome] = useState<QueryOutcome>({ status: 'idle' })
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  const pendingSearch = useRef<AbortController | null>(null)
  const pendingAsk = useRef<AbortController | null>(null)

  const filterInputId = useId()
  const queryInputId = useId()
  const modeName = useId()

  const rawFolder = useMemo(() => new URLSearchParams(locationSearch).get('folder'), [locationSearch])
  const currentFolder = normalizeFolder(rawFolder)
  const initialQueryFilter = useMemo(() => new URLSearchParams(locationSearch).get('q') ?? '', [locationSearch])
  const fileFilter = fileFilterState.fromUrl === initialQueryFilter ? fileFilterState.value : initialQueryFilter
  const setFileFilter = (value: string): void => setFileFilterState({ fromUrl: initialQueryFilter, value })

  const reload = useCallback(() => {
    setFilesState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    loadFiles({ source, ...(repoName !== undefined ? { name: repoName } : {}) }, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setFilesState({ status: 'done', documents: res.documents, total: res.total, cached: res.cached })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFilesState({ status: 'error', message: filesErrorMessage(error) })
        }
      })
    return () => controller.abort()
  }, [source, repoName, attempt, online])

  useEffect(() => {
    if (repoName === undefined || !online) return
    const controller = new AbortController()
    getRepoOverview(repoName, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setOverview(data)
        setOverviewMissing(false)
        setOverviewError(null)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 404) {
          setOverviewMissing(true)
          setOverview(null)
          setOverviewError(null)
        } else {
          setOverviewMissing(false)
          setOverviewError(overviewErrorMessage(error))
        }
      })
    getRepoStatuses(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setRepoStatus(rows.find((row) => row.name === repoName) ?? null)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [repoName, online, attempt])

  useEffect(() => {
    if (repoName === undefined || sync?.phase !== 'running') return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getRepoStatuses(controller.signal).then(
        (rows) => {
          if (controller.signal.aborted) return
          const row = rows.find((candidate) => candidate.name === repoName) ?? null
          setRepoStatus(row)
          if (row?.syncing === true) {
            setPollTick((n) => n + 1)
            return
          }
          setSync(row?.state === 'error' ? { phase: 'failed', message: syncFailedMessage(row.reason) } : { phase: 'done' })
          reload()
        },
        () => {
          if (!controller.signal.aborted) setSync({ phase: 'failed', message: SYNC_CHECK_FAILED_MESSAGE })
        },
      )
    }, pollMs)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [repoName, sync?.phase, pollTick, pollMs, reload])

  useEffect(() => {
    return () => {
      pendingSearch.current?.abort()
      pendingAsk.current?.abort()
    }
  }, [])

  const parts = useMemo(
    () => (overview?.summary ? parseRepoSummary(overview.summary.text) : null),
    [overview],
  )

  const pageTitle = repoName ?? SOURCE_PAGE_TITLE[source]
  const backHref = repoName !== undefined ? pathFor('repos') : pathFor('sources')
  const backLabel = repoName !== undefined ? 'Back to repos' : 'Back to sources'
  const folderHref = (folder: string): string =>
    repoName !== undefined ? repoPath(repoName, folder) : sourceBrowsePath(source, folder)

  const runScopedQuery = async (text: string, mode: QueryMode): Promise<void> => {
    pendingSearch.current?.abort()
    pendingAsk.current?.abort()
    pendingAsk.current = null
    setAnswer(null)

    if (!online) {
      pendingSearch.current = null
      if (mode === 'ask') {
        setAnswer({ status: 'error', message: 'You’re offline. Ask needs a connection.' })
        setQueryOutcome({ status: 'idle' })
        return
      }
      if (typeof indexedDB === 'undefined') {
        setQueryOutcome({ status: 'error', query: text, message: OFFLINE_MESSAGE })
        return
      }
      const controller = new AbortController()
      pendingSearch.current = controller
      setQueryOutcome({ status: 'loading', query: text })
      try {
        const results = await searchOffline({
          query: text,
          sources: [source],
          ...(repoName !== undefined ? { repo: repoName } : {}),
        })
        if (!controller.signal.aborted) {
          setQueryOutcome({ status: 'done', query: text, response: { results, degraded: false }, offline: true })
        }
      } catch {
        if (!controller.signal.aborted) setQueryOutcome({ status: 'error', query: text, message: OFFLINE_MESSAGE })
      }
      return
    }

    if (mode === 'ask') {
      const askController = new AbortController()
      pendingAsk.current = askController
      setAnswer({ status: 'loading' })
      setQueryOutcome({ status: 'idle' })
      try {
        const response = await askQuestion(
          { question: text, sources: [source], ...(repoName !== undefined ? { repo: repoName } : {}) },
          askController.signal,
        )
        if (!askController.signal.aborted) setAnswer({ status: 'done', response })
      } catch (error) {
        if (!askController.signal.aborted) setAnswer({ status: 'error', message: askErrorMessage(error, false) })
      }
      return
    }

    const searchController = new AbortController()
    pendingSearch.current = searchController
    setQueryOutcome({ status: 'loading', query: text })
    try {
      const response = await searchNotes(
        { query: text, sources: [source], ...(repoName !== undefined ? { repo: repoName } : {}), limit: SEARCH_LIMIT },
        searchController.signal,
      )
      if (!searchController.signal.aborted) setQueryOutcome({ status: 'done', query: text, response, offline: false })
    } catch (error) {
      if (!searchController.signal.aborted) setQueryOutcome({ status: 'error', query: text, message: searchErrorMessage(error) })
    }
  }

  const submitQuery = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const trimmed = queryText.trim()
    if (trimmed === '') return
    void runScopedQuery(trimmed, queryMode)
  }

  const clearQuery = (): void => {
    pendingSearch.current?.abort()
    pendingAsk.current?.abort()
    pendingSearch.current = null
    pendingAsk.current = null
    setQueryText('')
    setQueryOutcome({ status: 'idle' })
    setAnswer(null)
  }

  const handleResync = (): void => {
    if (repoName === undefined || isSyncBusy(sync)) return
    setSync({ phase: 'starting' })
    startRepoSync(repoName).then(
      () => setSync({ phase: 'running' }),
      (error: unknown) => setSync({ phase: 'failed', message: resyncErrorMessage(error) }),
    )
  }

  const handleTogglePin = (): void => {
    if (repoName === undefined) return
    setPinError(
      setRepoPinned(repoName, !pins.includes(repoName))
        ? null
        : 'This browser refused to save the pin. Check its storage settings.',
    )
  }

  const documents = useMemo(
    () => (filesState.status === 'done' ? filesState.documents : []),
    [filesState],
  )
  const nested = useMemo(() => source !== 'keep' && hasFolders(documents), [source, documents])
  const effectiveView: 'folders' | 'all' =
    fileFilter.trim() !== '' ? 'all' : currentFolder !== '' ? 'folders' : nested ? viewMode : 'all'

  const filteredDocs = useMemo(() => filterDocuments(documents, fileFilter), [documents, fileFilter])
  const slice = useMemo(
    () => (effectiveView === 'folders' ? folderSlice(documents, currentFolder) : null),
    [effectiveView, documents, currentFolder],
  )
  const crumbs = useMemo(() => breadcrumbsFor(pageTitle, currentFolder), [pageTitle, currentFolder])

  const HeaderIcon = SOURCE_PAGE_ICON[source]
  const pinState = repoName !== undefined ? pinStateOf(repoName, pins, cachedRepos) : 'online'
  const pinned = pinState !== 'online'
  const PinIcon = pinned ? PinOff : Pin
  const summaryId = overview?.summary?.documentId ?? null
  const busy = isSyncBusy(sync) || repoStatus?.syncing === true
  const queryActive = queryOutcome.status !== 'idle' || answer !== null

  return (
    <div className="space-y-6">
      <div>
        <a
          href={backHref}
          onClick={(event) => followLink(event, backHref)}
          className="-ml-3 mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {backLabel}
        </a>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            {repoName !== undefined ? (
              <RepoTile name={repoName} large />
            ) : (
              <span
                aria-hidden="true"
                className="inline-flex size-12 shrink-0 items-center justify-center rounded-control bg-accent text-on-accent"
              >
                <HeaderIcon className="size-6" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight break-all md:text-3xl">{pageTitle}</h1>
                {filesState.status === 'done' && filesState.cached ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 text-xs text-muted">
                    <HardDrive aria-hidden="true" className="size-3.5" />
                    Saved copy
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted">
                {repoName !== undefined ? (
                  <>
                    {parts?.branch != null ? `GitHub repo · ${parts.branch}` : 'GitHub repo'}
                    {filesState.status === 'done'
                      ? ` · ${plural(filesState.total, 'file')} indexed`
                      : overview !== null
                        ? ` · ${plural(overview.files, 'file')} indexed`
                        : ''}
                  </>
                ) : filesState.status === 'done' ? (
                  `${plural(filesState.total, source === 'obsidian' || source === 'keep' ? 'note' : 'file')} indexed`
                ) : (
                  'Browse indexed files, search, or ask a question.'
                )}
              </p>
              {parts?.description != null ? <p className="mt-1.5 max-w-prose text-sm text-ink/80">{parts.description}</p> : null}
              {overviewError !== null ? <p className="mt-1 text-xs text-muted">{overviewError}</p> : null}
            </div>
          </div>

          {repoName !== undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              {summaryId === null ? null : (
                <a
                  href={documentPath(summaryId)}
                  onClick={(event) => followLink(event, documentPath(summaryId))}
                  className={OUTLINE_BUTTON}
                >
                  <FileText aria-hidden="true" className="size-4" />
                  Overview
                </a>
              )}
              <button type="button" onClick={handleResync} disabled={!online || busy} className={OUTLINE_BUTTON}>
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
                onClick={handleTogglePin}
                className={`${OUTLINE_BUTTON} ${pinned ? 'border-accent bg-raised text-accent-ink' : ''}`}
              >
                <PinIcon aria-hidden="true" className="size-4" />
                {pinState === 'cached' ? 'Cached' : pinned ? 'Pinned' : 'Pin offline'}
              </button>
            </div>
          ) : null}
        </header>

        {pinError === null ? null : <Alert message={pinError} />}
        {sync?.phase === 'failed' ? <Alert message={sync.message} /> : null}
      </div>

      {/* Scoped Search & Ask */}
      <section aria-label={`Search or ask in ${pageTitle}`}>
        <form
          role="search"
          onSubmit={submitQuery}
          className="rounded-card border border-line bg-surface p-3 shadow-[0_1px_2px_rgb(15_15_16/0.05)] md:p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <fieldset className="inline-flex shrink-0 gap-0.5 rounded-control bg-raised p-1">
              <legend className="sr-only">Mode</legend>
              {(
                [
                  { value: 'search', label: 'Search', icon: Search },
                  { value: 'ask', label: 'Ask', icon: Sparkles },
                ] as const
              ).map(({ value, label, icon: ModeIcon }) => (
                <label
                  key={value}
                  className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[0.5625rem] px-3 text-sm font-medium text-ink/80 transition-colors hover:text-ink has-checked:bg-strong has-checked:text-on-strong has-focus-visible:outline-2 has-focus-visible:outline-accent-ink"
                >
                  <input
                    type="radio"
                    name={modeName}
                    value={value}
                    checked={queryMode === value}
                    onChange={() => {
                      setQueryMode(value)
                      if (value === 'search') {
                        pendingAsk.current?.abort()
                        setAnswer(null)
                      }
                    }}
                    className="sr-only"
                  />
                  <ModeIcon aria-hidden="true" className="size-4" />
                  {label}
                </label>
              ))}
            </fieldset>

            <label htmlFor={queryInputId} className="sr-only">
              {queryMode === 'ask' ? `Ask a question about ${pageTitle}` : `Search in ${pageTitle}`}
            </label>
            <input
              id={queryInputId}
              type="search"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              placeholder={queryMode === 'ask' ? `Ask a question about ${pageTitle}…` : `Search inside ${pageTitle}…`}
              autoComplete="off"
              maxLength={1000}
              className="min-h-11 min-w-48 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted focus-visible:border-accent-ink focus-visible:outline-none"
            />
            {queryActive ? (
              <button type="button" onClick={clearQuery} className={OUTLINE_BUTTON}>
                <X aria-hidden="true" className="size-4" />
                Clear
              </button>
            ) : null}
            <button
              type="submit"
              aria-label={queryMode === 'ask' ? 'Ask' : 'Search'}
              disabled={queryText.trim() === '' || (queryMode === 'ask' && !online)}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-control bg-strong px-4 text-sm font-medium text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp aria-hidden="true" className="size-4" />
              {queryMode === 'ask' ? 'Ask' : 'Search'}
            </button>
          </div>
          {queryMode === 'ask' ? (
            <p className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
              <Lock aria-hidden="true" className="size-3.5 shrink-0 text-accent-ink" />
              {online
                ? 'Answers come from Gemini. Locked files stay local and fall back to the local model or snippets.'
                : 'You’re offline. Ask needs a connection; Search still works on cached files.'}
            </p>
          ) : null}
        </form>

        {answer !== null ? (
          <div className="mt-4 space-y-3">
            <AskAnswer state={answer} />
            {answer.status === 'done' && answer.response.answer === null && answer.response.citations.length === 0 ? (
              <p role="status" className="rounded-card border border-line bg-surface p-4 text-sm text-muted">
                Nothing in {pageTitle} matches this question. Try different words.
              </p>
            ) : null}
          </div>
        ) : null}

        {queryOutcome.status === 'loading' ? (
          <p aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-muted">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Searching {pageTitle}…
          </p>
        ) : queryOutcome.status === 'error' ? (
          <div className="mt-4">
            <Alert message={queryOutcome.message} />
          </div>
        ) : queryOutcome.status === 'done' ? (
          <div className="mt-4 space-y-3">
            <h2 className="text-sm font-medium text-muted">
              {queryOutcome.response.results.length === 0
                ? `No matches for “${queryOutcome.query}” in ${pageTitle}`
                : `${resultCount(queryOutcome.response.results.length)} in ${pageTitle}`}
            </h2>
            {queryOutcome.response.results.length > 0 ? (
              <ol className="space-y-3">
                {queryOutcome.response.results.map((result) => (
                  <li key={result.chunkId}>
                    <ResultCard result={result} preview={notePreviews} />
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* File Browser */}
      <section aria-label={`Files in ${pageTitle}`} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-h-11 min-w-52 flex-1 items-center gap-2 rounded-control border border-line bg-surface px-3 focus-within:border-muted">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <label htmlFor={filterInputId} className="sr-only">
              Filter files
            </label>
            <input
              id={filterInputId}
              type="search"
              value={fileFilter}
              onChange={(event) => setFileFilter(event.target.value)}
              placeholder="Filter files by name or path"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink outline-none placeholder:text-muted"
            />
          </div>

          {nested && fileFilter.trim() === '' ? (
            <div role="group" aria-label="File view" className="inline-flex rounded-control bg-raised p-1">
              <button
                type="button"
                aria-pressed={effectiveView === 'folders'}
                onClick={() => {
                  setViewMode('folders')
                }}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-[0.5rem] px-3 text-sm transition-colors ${
                  effectiveView === 'folders' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'
                }`}
              >
                <Folder aria-hidden="true" className="size-4" />
                Folders
              </button>
              <button
                type="button"
                aria-pressed={effectiveView === 'all'}
                onClick={() => {
                  setViewMode('all')
                  if (currentFolder !== '') navigate(folderHref(''))
                }}
                className={`inline-flex min-h-10 items-center gap-1.5 rounded-[0.5rem] px-3 text-sm transition-colors ${
                  effectiveView === 'all' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'
                }`}
              >
                <List aria-hidden="true" className="size-4" />
                All files
              </button>
            </div>
          ) : null}
        </div>

        {filesState.status === 'loading' ? (
          <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Loading files…
          </p>
        ) : filesState.status === 'error' ? (
          <Alert message={filesState.message} onRetry={online ? reload : undefined} />
        ) : overviewMissing && documents.length === 0 ? (
          <div className="rounded-card border border-line bg-surface p-6 text-center text-sm text-muted">
            Repo “{repoName}” wasn’t found on this server.
          </div>
        ) : documents.length === 0 ? (
          <div className="rounded-card border border-line bg-surface p-6 text-center text-sm text-muted">
            {!online
              ? repoName !== undefined
                ? 'You’re offline. Pin this repo while online to view and search its files offline.'
                : 'You’re offline and no cached files for this source are on this device yet.'
              : source === 'keep'
                ? 'No Google Keep notes imported yet. Upload a Takeout zip on Sources and sync.'
                : 'No files indexed yet.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-surface shadow-[0_1px_2px_rgb(15_15_16/0.04)]">
            {effectiveView === 'folders' && currentFolder !== '' ? (
              <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 border-b border-line bg-raised/50 px-3 py-2 text-sm">
                {crumbs.map((crumb, index) => {
                  const last = index === crumbs.length - 1
                  const href = folderHref(crumb.path)
                  return (
                    <span key={crumb.path || 'root'} className="inline-flex items-center gap-1">
                      {index > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 text-muted" /> : null}
                      {last ? (
                        <span className="px-1.5 py-1 font-medium text-ink">{crumb.label}</span>
                      ) : (
                        <a
                          href={href}
                          onClick={(event) => followLink(event, href)}
                          className="inline-flex min-h-9 items-center rounded-control px-2 text-accent-ink hover:bg-raised"
                        >
                          {crumb.label}
                        </a>
                      )}
                    </span>
                  )
                })}
              </nav>
            ) : null}

            {effectiveView === 'folders' && slice !== null ? (
              slice.folders.length === 0 && slice.files.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted">
                  This folder has no indexed files.{' '}
                  <a
                    href={folderHref('')}
                    onClick={(event) => followLink(event, folderHref(''))}
                    className="font-medium text-accent-ink underline underline-offset-4"
                  >
                    Back to top level
                  </a>
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {slice.folders.map((folder) => {
                    const href = folderHref(folder.path)
                    return (
                      <li key={`dir:${folder.path}`}>
                        <a
                          href={href}
                          onClick={(event) => followLink(event, href)}
                          className="flex min-h-12 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised"
                        >
                          <Folder aria-hidden="true" className="size-4 shrink-0 text-accent-ink" />
                          <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-ink">
                            {folder.name}/
                          </span>
                          <span className="shrink-0 text-xs text-muted tabular-nums">
                            {plural(folder.count, 'file')}
                          </span>
                          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
                        </a>
                      </li>
                    )
                  })}
                  {slice.files.map((doc) => (
                    <FileRow key={doc.id} doc={doc} source={source} inFolderView={true} now={now} timeZone={timeZone} />
                  ))}
                </ul>
              )
            ) : filteredDocs.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted">No files match “{fileFilter.trim()}”.</p>
            ) : (
              <ul className="divide-y divide-line">
                {filteredDocs.map((doc) => (
                  <FileRow key={doc.id} doc={doc} source={source} inFolderView={false} now={now} timeZone={timeZone} />
                ))}
              </ul>
            )}

            {filesState.total > documents.length ? (
              <p className="border-t border-line bg-raised/40 px-4 py-2.5 text-xs text-muted">
                Showing the first {documents.length.toLocaleString('en-US')} of {filesState.total.toLocaleString('en-US')} indexed files. Use Search above to find any file.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}

function FileRow({
  doc,
  source,
  inFolderView,
  now,
  timeZone,
}: {
  doc: DocumentInfo
  source: SourceKind
  inFolderView: boolean
  now: number
  timeZone: string
}) {
  const href = documentPath(doc.id)
  const { primary, secondary } = fileLabel(doc, source, inFolderView)
  const FileIcon = isCodeFile(doc) ? FileCode : SOURCE_ICONS[source] ?? FileText
  const when = timeAgo(doc.mtime ?? doc.updatedAt, now, timeZone)

  return (
    <li>
      <a
        href={href}
        onClick={(event) => followLink(event, href)}
        className="flex min-h-12 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised"
      >
        <FileIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-medium text-ink ${doc.source.kind === 'repo' && inFolderView ? 'font-mono' : ''}`}>
            {primary}
          </p>
          {secondary === null ? null : (
            <p className="mt-0.5 truncate font-mono text-xs text-muted" title={doc.path}>
              {secondary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
          {doc.language === null ? null : (
            <span className="hidden rounded-full bg-raised px-2 py-0.5 sm:inline-block">{doc.language}</span>
          )}
          {doc.allowLlm ? null : (
            <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5" title="Never sent to Gemini">
              <Lock aria-hidden="true" className="size-3" />
              <span className="hidden sm:inline">Local only</span>
            </span>
          )}
          {when === '' ? null : (
            <time dateTime={doc.mtime ?? doc.updatedAt} className="tabular-nums">
              {when}
            </time>
          )}
        </div>
      </a>
    </li>
  )
}

function Alert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
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

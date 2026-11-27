import { ArrowLeft, FolderGit2, LoaderCircle, RotateCw, Search, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { getRepoOverview, listRepos, type RepoInfo } from '../api/repos'
import { getRepoStatuses, startRepoSync, type RepoStatus } from '../api/repoSync'
import { getLlmExclusions, saveLlmExclusions, type LlmExclusion } from '../api/settings'
import { Placeholder, ScreenHeader } from '../components/Screen'
import { ScrollRow } from '../components/ScrollRow'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { useProfile } from '../profile/profile'
import { isRepoLocked, withRepoRule } from '../repos/allowAsk'
import {
  overviewErrorMessage,
  plural,
  repoListErrorMessage,
  REPOS_OFFLINE_MESSAGE,
  REPOS_WIDE_QUERY,
  resyncErrorMessage,
  rulesLoadErrorMessage,
  rulesSaveErrorMessage,
  SYNC_CHECK_FAILED_MESSAGE,
  SYNC_POLL_MS,
  syncFailedMessage,
} from '../repos/format'
import { PinBadge, RepoDetail, RepoTile } from '../repos/RepoDetail'
import { setRepoPinned, usePinnedRepos } from '../repos/pins'
import { isSyncBusy, type AllowAskState, type OverviewEntry, type SyncEntry } from '../repos/state'
import { parseRepoSummary, type RepoSummaryParts } from '../repos/summary'
import { pinStateOf, useCachedRepos, type PinState } from '../repos/useCachedRepos'
import { timeAgo } from '../search/format'

// Repos (T44, R6, R9, R16): filter, language chips, repo cards and a detail
// panel. From `md` the panel sits beside the list (Desktop and Tablet
// boards); narrower screens open it in place of the list with a Back button
// (Mobile: Repo detail board).

type ListState = { status: 'loading' } | { status: 'done'; repos: RepoInfo[] } | { status: 'error'; message: string }

type RulesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rules: LlmExclusion[] }

/** Overviews loaded at the same time; a personal server has a handful of repos. */
const OVERVIEW_CONCURRENCY = 4
const CARD_LANGUAGES = 3

const sortRepos = (repos: readonly RepoInfo[]): RepoInfo[] => [...repos].sort((a, b) => a.name.localeCompare(b.name))

export function ReposScreen({ pollMs = SYNC_POLL_MS }: { pollMs?: number } = {}) {
  const online = useOnline()
  const wide = useMediaQuery(REPOS_WIDE_QUERY)
  const { timeZone } = useProfile()
  const pins = usePinnedRepos()
  const cached = useCachedRepos(pins)
  const [now] = useState(Date.now)
  const detailHeadingId = useId()

  const [list, setList] = useState<ListState>({ status: 'loading' })
  // Bumped by Retry; each value (and each return online) loads the page again.
  const [attempt, setAttempt] = useState(0)
  const [overviews, setOverviews] = useState<ReadonlyMap<string, OverviewEntry>>(new Map())
  const [statuses, setStatuses] = useState<readonly RepoStatus[] | null>(null)
  const [rules, setRules] = useState<RulesState>({ status: 'loading' })
  const [savingRule, setSavingRule] = useState<string | null>(null)
  const [ruleError, setRuleError] = useState<{ name: string; message: string } | null>(null)
  const [syncs, setSyncs] = useState<ReadonlyMap<string, SyncEntry>>(new Map())
  const [pollTick, setPollTick] = useState(0)
  const [pinError, setPinError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [language, setLanguage] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const pending = useRef(new Set<AbortController>())
  useEffect(() => {
    const controllers = pending.current
    return () => {
      for (const controller of controllers) controller.abort()
    }
  }, [])

  /** Loads one overview; `quiet` keeps what is shown until the new one arrives (after a Re-sync). */
  const loadOverview = useCallback((name: string, quiet = false): Promise<void> => {
    const controller = new AbortController()
    pending.current.add(controller)
    if (!quiet) setOverviews((map) => new Map(map).set(name, { status: 'loading' }))
    return getRepoOverview(name, controller.signal)
      .then(
        (overview) => {
          if (!controller.signal.aborted) setOverviews((map) => new Map(map).set(name, { status: 'done', overview }))
        },
        (error: unknown) => {
          if (controller.signal.aborted || quiet) return
          setOverviews((map) => new Map(map).set(name, { status: 'error', message: overviewErrorMessage(error) }))
        },
      )
      .finally(() => pending.current.delete(controller))
  }, [])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    listRepos(controller.signal)
      .then(async (repos) => {
        if (controller.signal.aborted) return
        const sorted = sortRepos(repos)
        setList({ status: 'done', repos: sorted })
        // Languages, descriptions and the folder list come from each repo's overview.
        const names = sorted.map((repo) => repo.name)
        let next = 0
        const worker = async (): Promise<void> => {
          while (next < names.length && !controller.signal.aborted) {
            const name = names[next++]
            if (name !== undefined) await loadOverview(name)
          }
        }
        await Promise.all(Array.from({ length: Math.min(OVERVIEW_CONCURRENCY, names.length) }, worker))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setList({ status: 'error', message: repoListErrorMessage(error) })
      })
    getRepoStatuses(controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted) setStatuses(rows)
      },
      () => {
        // Without status the panel says "Unknown" for Last synced; Re-sync still works.
      },
    )
    getLlmExclusions(controller.signal).then(
      (exclusions) => {
        if (!controller.signal.aborted) setRules({ status: 'ready', rules: exclusions })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setRules({ status: 'error', message: rulesLoadErrorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [online, attempt, loadOverview])

  // While a Re-sync started here is running, ask the server every `pollMs`
  // until its `syncing` flag is off, then refresh the repo's numbers.
  const runningKey = [...syncs]
    .filter(([, sync]) => sync.phase === 'running')
    .map(([name]) => name)
    .sort()
    .join('\n')
  useEffect(() => {
    if (runningKey === '') return
    const names = runningKey.split('\n')
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      getRepoStatuses(controller.signal).then(
        (rows) => {
          if (controller.signal.aborted) return
          setStatuses(rows)
          const finished = names.filter((name) => rows.find((row) => row.name === name)?.syncing !== true)
          if (finished.length === 0) {
            setPollTick((n) => n + 1)
            return
          }
          setSyncs((map) => {
            const next = new Map(map)
            for (const name of finished) {
              const row = rows.find((candidate) => candidate.name === name)
              next.set(name, row?.state === 'error' ? { phase: 'failed', message: syncFailedMessage(row.reason) } : { phase: 'done' })
            }
            return next
          })
          listRepos().then(
            (repos) => setList({ status: 'done', repos: sortRepos(repos) }),
            () => {
              // Keep the numbers shown; the next visit loads them again.
            },
          )
          for (const name of finished) void loadOverview(name, true)
        },
        () => {
          if (controller.signal.aborted) return
          setSyncs((map) => {
            const next = new Map(map)
            for (const name of names) next.set(name, { phase: 'failed', message: SYNC_CHECK_FAILED_MESSAGE })
            return next
          })
        },
      )
    }, pollMs)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [runningKey, pollTick, pollMs, loadOverview])

  const reload = (): void => {
    setList({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  const parts = useMemo(() => {
    const map = new Map<string, RepoSummaryParts>()
    for (const [name, entry] of overviews) {
      if (entry.status === 'done' && entry.overview.summary !== null) map.set(name, parseRepoSummary(entry.overview.summary.text))
    }
    return map
  }, [overviews])

  const repos = list.status === 'done' ? list.repos : []
  const languagesOf = (name: string): string[] => parts.get(name)?.languages.map((share) => share.name) ?? []

  const languageCounts = new Map<string, number>()
  for (const repo of repos) for (const name of languagesOf(repo.name)) languageCounts.set(name, (languageCounts.get(name) ?? 0) + 1)
  const chips = [...languageCounts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
  // A chosen language that no repo has any more (after a Re-sync) stops filtering.
  const activeLanguage = language !== null && languageCounts.has(language) ? language : null

  const needle = query.trim().toLowerCase()
  const visible = repos.filter((repo) => {
    const languages = languagesOf(repo.name)
    if (activeLanguage !== null && !languages.includes(activeLanguage)) return false
    if (needle === '') return true
    return repo.name.toLowerCase().includes(needle) || languages.some((name) => name.toLowerCase().includes(needle))
  })

  const current = wide
    ? (visible.find((repo) => repo.name === selected) ?? visible[0] ?? null)
    : (repos.find((repo) => repo.name === selected) ?? null)

  const select = (name: string): void => {
    setSelected(name)
    // On a phone the panel replaces the list: start reading at its heading.
    if (!wide) requestAnimationFrame(() => document.getElementById(detailHeadingId)?.focus())
  }

  const back = (): void => {
    const name = selected
    setSelected(null)
    requestAnimationFrame(() => {
      for (const card of document.querySelectorAll<HTMLElement>('[data-repo-card]')) {
        if (card.dataset.repoCard === name) card.focus()
      }
    })
  }

  const togglePin = (name: string): void => {
    setPinError(setRepoPinned(name, !pins.includes(name)) ? null : 'This browser refused to save the pin. Check its storage settings.')
  }

  const resync = (name: string): void => {
    if (isSyncBusy(syncs.get(name))) return
    setSyncs((map) => new Map(map).set(name, { phase: 'starting' }))
    startRepoSync(name).then(
      () => setSyncs((map) => new Map(map).set(name, { phase: 'running' })),
      (error: unknown) => setSyncs((map) => new Map(map).set(name, { phase: 'failed', message: resyncErrorMessage(error) })),
    )
  }

  const setAllowAsk = (name: string, allowed: boolean): void => {
    if (rules.status !== 'ready' || savingRule !== null) return
    setSavingRule(name)
    setRuleError(null)
    // The server keeps one list: send all of it, with only this repo's rule changed.
    saveLlmExclusions(withRepoRule(rules.rules, name, !allowed))
      .then((saved) => {
        setRules({ status: 'ready', rules: saved })
        setOverviews((map) => {
          const entry = map.get(name)
          if (entry?.status !== 'done' || entry.overview.summary === null) return map
          const overview = { ...entry.overview, summary: { ...entry.overview.summary, allowLlm: allowed } }
          return new Map(map).set(name, { status: 'done', overview })
        })
      })
      .catch((error: unknown) => setRuleError({ name, message: rulesSaveErrorMessage(error) }))
      .finally(() => setSavingRule(null))
  }

  const allowAskFor = (name: string): AllowAskState => {
    if (rules.status === 'loading') return { state: 'loading' }
    if (rules.status === 'error') {
      const entry = overviews.get(name)
      const allowed = entry?.status === 'done' && entry.overview.summary !== null ? entry.overview.summary.allowLlm : null
      return { state: 'error', message: rules.message, allowed }
    }
    return {
      state: 'ready',
      allowed: !isRepoLocked(rules.rules, name),
      saving: savingRule !== null,
      error: ruleError?.name === name ? ruleError.message : null,
    }
  }

  const detail =
    current === null ? null : (
      <RepoDetail
        repo={current}
        headingId={detailHeadingId}
        overview={overviews.get(current.name)}
        parts={parts.get(current.name) ?? null}
        status={statuses === null ? undefined : (statuses.find((row) => row.name === current.name) ?? null)}
        now={now}
        timeZone={timeZone}
        online={online}
        pinState={pinStateOf(current.name, pins, cached)}
        onTogglePin={() => togglePin(current.name)}
        allowAsk={allowAskFor(current.name)}
        onAllowAsk={(allowed) => setAllowAsk(current.name, allowed)}
        sync={syncs.get(current.name)}
        onResync={() => resync(current.name)}
        onRetryOverview={() => void loadOverview(current.name)}
      />
    )

  const shown: ListState = online ? list : { status: 'error', message: REPOS_OFFLINE_MESSAGE }
  const pinAlert = pinError === null ? null : <Alert message={pinError} />

  if (!wide && current !== null && shown.status === 'done') {
    return (
      <>
        <button
          type="button"
          onClick={back}
          className="-ml-3 mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to repos
        </button>
        {pinAlert}
        {detail}
      </>
    )
  }

  return (
    <>
      <ScreenHeader
        title="Repos"
        description={
          shown.status === 'done' && repos.length > 0
            ? `${plural(repos.length, 'repo')} indexed. Code, README and manifests only.`
            : 'Your personal GitHub repos. Pin one to keep its files on this device for offline search.'
        }
      />
      {pinAlert}
      {shown.status === 'loading' ? (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Loading repos…
        </p>
      ) : shown.status === 'error' ? (
        <Alert message={shown.message} onRetry={online ? reload : undefined} />
      ) : repos.length === 0 ? (
        <Placeholder icon={FolderGit2} title="No repos indexed yet">
          Repos appear here once GitHub indexing is set up, with an overview and an offline pin for each.
        </Placeholder>
      ) : (
        <div className="md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:items-start md:gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-label="Repo list" className="@container min-w-0">
            <Filters
              query={query}
              onQuery={setQuery}
              total={repos.length}
              chips={chips}
              language={activeLanguage}
              onLanguage={setLanguage}
            />
            {visible.length === 0 ? (
              <p className="mt-4 rounded-card border border-line bg-surface px-4 py-6 text-center text-sm text-muted">
                No repo matches this filter.
              </p>
            ) : (
              <ul className="mt-4 grid gap-3 @2xl:grid-cols-2">
                {visible.map((repo) => (
                  <li key={repo.name}>
                    <RepoCard
                      repo={repo}
                      parts={parts.get(repo.name) ?? null}
                      selected={wide && current?.name === repo.name}
                      pinState={pinStateOf(repo.name, pins, cached)}
                      now={now}
                      timeZone={timeZone}
                      onSelect={() => select(repo.name)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          {wide && detail !== null ? (
            <aside aria-label="Repo details" className="md:sticky md:top-4">
              {detail}
            </aside>
          ) : null}
        </div>
      )}
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

const CHIP =
  'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border border-line px-3.5 text-sm whitespace-nowrap text-muted transition-colors hover:border-muted/50 hover:text-ink aria-pressed:border-accent aria-pressed:bg-raised aria-pressed:text-ink'

function Filters({
  query,
  onQuery,
  total,
  chips,
  language,
  onLanguage,
}: {
  query: string
  onQuery: (value: string) => void
  total: number
  chips: ReadonlyArray<[string, number]>
  language: string | null
  onLanguage: (value: string | null) => void
}) {
  const inputId = useId()
  return (
    <div className="space-y-3">
      <label htmlFor={inputId} className="sr-only">
        Filter repos
      </label>
      <div className="flex min-h-12 items-center gap-2 rounded-control border border-line bg-surface px-3 focus-within:border-muted">
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted" />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filter by name or language"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink outline-none placeholder:text-muted"
        />
      </div>
      <ScrollRow role="group" aria-label="Filter by language" className="-m-1 flex gap-2 p-1">
        <button type="button" aria-pressed={language === null} onClick={() => onLanguage(null)} className={CHIP}>
          All
          <span className="tabular-nums">· {total}</span>
        </button>
        {chips.map(([name, count]) => (
          <button
            key={name}
            type="button"
            aria-pressed={language === name}
            onClick={() => onLanguage(language === name ? null : name)}
            className={CHIP}
          >
            {name}
            <span className="tabular-nums">· {count}</span>
          </button>
        ))}
      </ScrollRow>
    </div>
  )
}

function RepoCard({
  repo,
  parts,
  selected,
  pinState,
  now,
  timeZone,
  onSelect,
}: {
  repo: RepoInfo
  parts: RepoSummaryParts | null
  selected: boolean
  pinState: PinState
  now: number
  timeZone: string
  onSelect: () => void
}) {
  const languages = parts?.languages.slice(0, CARD_LANGUAGES) ?? []
  return (
    <article
      className={`relative h-full rounded-card border bg-surface p-4 shadow-[0_1px_2px_rgb(15_15_16/0.05)] transition-colors duration-150 ${
        selected ? 'border-strong' : 'border-line hover:border-muted/50'
      }`}
    >
      <div className="flex items-center gap-3">
        <RepoTile name={repo.name} />
        <h3 className="min-w-0 flex-1 text-base font-semibold break-all">
          <button
            type="button"
            data-repo-card={repo.name}
            aria-current={selected ? 'true' : undefined}
            onClick={onSelect}
            className="text-left outline-none after:absolute after:inset-0 after:rounded-card focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ink"
          >
            {repo.name}
          </button>
        </h3>
        <span className="shrink-0 text-xs text-muted">
          {repo.updatedAt === null ? (
            'Not indexed yet'
          ) : (
            <time dateTime={repo.updatedAt}>{timeAgo(repo.updatedAt, now, timeZone)}</time>
          )}
        </span>
      </div>
      {parts?.description == null ? null : <p className="mt-2 line-clamp-2 text-sm text-ink/80">{parts.description}</p>}
      {languages.length === 0 ? null : (
        <ul aria-label="Languages" className="mt-2 flex flex-wrap gap-1.5">
          {languages.map((share) => (
            <li key={share.name} className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink">
              {share.name}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted">
        <span>
          {plural(repo.files, 'file')} indexed · {plural(repo.chunks, 'chunk')}
        </span>
        <PinBadge state={pinState} />
      </div>
    </article>
  )
}

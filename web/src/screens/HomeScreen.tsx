import { ArrowRight, Clock, History, Pin, Sparkles, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { DocumentInfo } from '../api/documents'
import { getRecentDocuments, getRecentQueries, type RecentQuery } from '../api/recent'
import { offlineDb } from '../offline/db'
import { formatBytes } from '../offline/storage'
import { readSyncState } from '../offline/sync'
import { usePinnedRepos } from '../repos/pins'
import { documentPath, followLink, pathFor } from '../router'
import { timeAgo } from '../search/format'
import { RECENT_CHANGES_DAYS, TRY_ASKING_EXAMPLES } from './home'

// Home (T31): what `/` shows before anything is searched. SearchScreen owns
// the search box and puts these around it; a search or question replaces the
// cards with results, and New search brings them back.

const RECENT_CHANGES_SHOWN = 3
const PINNED_SHOWN = 3
const QUESTIONS_SHOWN = 3
const SEARCHES_SHOWN = 5

export function Greeting({ name }: { name: string }) {
  const trimmed = name.trim()
  const big = 'text-[1.875rem] leading-[1.05] font-semibold tracking-[-0.03em] md:text-[2.5rem] lg:text-[3.25rem]'
  return (
    <header className="text-center">
      <h1 className={`${big} break-words`}>{trimmed === '' ? 'Hi there' : `Hi, ${trimmed}`}</h1>
      <p className={`${big} mt-1.5 text-muted`}>What are you looking for?</p>
      <p className="mt-4 text-base text-ink/80 md:text-[1.0625rem]">
        Search your notes, repos and Keep, or ask a question.
      </p>
    </header>
  )
}

type Load<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error' } | { status: 'offline' }

/** Loads `load` while online; `load` must be stable (module level). */
function useServerData<T>(online: boolean, load: (signal: AbortSignal) => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ status: 'loading' })
  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    load(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ status: 'ready', value })
      },
      () => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [online, load])
  return online ? state : { status: 'offline' }
}

const loadRecentChanges = (signal: AbortSignal): Promise<DocumentInfo[]> =>
  getRecentDocuments({ days: RECENT_CHANGES_DAYS, limit: RECENT_CHANGES_SHOWN }, signal)
const loadRecentQuestions = (signal: AbortSignal): Promise<RecentQuery[]> =>
  getRecentQueries('ask', QUESTIONS_SHOWN, signal)
const loadRecentSearches = (signal: AbortSignal): Promise<RecentQuery[]> =>
  getRecentQueries('search', SEARCHES_SHOWN, signal)

function Card({
  icon: Icon,
  title,
  action,
  className = '',
  children,
}: {
  icon: LucideIcon
  title: string
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col gap-1 rounded-card border border-line/60 bg-surface p-4 shadow-[0_1px_2px_rgb(15_15_16/0.05)] ${className}`}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-[0.625rem] bg-accent text-on-accent">
          <Icon aria-hidden="true" className="size-[1.125rem]" />
        </span>
        <h2 id={headingId} className="min-w-0 flex-1 text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function CardLink({ path, children }: { path: string; children: ReactNode }) {
  return (
    <a
      href={path}
      onClick={(event) => followLink(event, path)}
      className="text-[0.8125rem] text-muted transition-colors hover:text-ink hover:underline"
    >
      {children}
    </a>
  )
}

function CardNote({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p role={alert ? 'alert' : undefined} className="px-2.5 py-2 text-sm text-muted">
      {children}
    </p>
  )
}

const rowClass = 'block w-full rounded-control px-2.5 py-2 text-left transition-colors hover:bg-raised'

function kindLabel(doc: DocumentInfo): string {
  if (doc.source.kind === 'repo') return doc.source.name
  return doc.source.kind === 'keep' ? 'Keep' : 'Note'
}

function RecentChanges({ online, timeZone, now }: { online: boolean; timeZone: string; now: number }) {
  const state = useServerData(online, loadRecentChanges)
  let body: ReactNode
  if (state.status === 'offline') body = <CardNote>Recent changes need a connection.</CardNote>
  else if (state.status === 'loading') body = <CardNote>Loading…</CardNote>
  else if (state.status === 'error') body = <CardNote alert>Couldn’t load recent changes.</CardNote>
  else if (state.value.length === 0) body = <CardNote>Nothing changed in the last {RECENT_CHANGES_DAYS} days.</CardNote>
  else {
    body = (
      <ul className="space-y-0.5">
        {state.value.slice(0, RECENT_CHANGES_SHOWN).map((doc) => {
          const path = documentPath(doc.id)
          const when = timeAgo(doc.mtime ?? doc.updatedAt, now, timeZone)
          return (
            <li key={doc.id}>
              <a href={path} onClick={(event) => followLink(event, path)} className={rowClass}>
                <span className="block truncate text-sm font-medium">{doc.title}</span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {when === '' ? kindLabel(doc) : `${kindLabel(doc)} · ${when}`}
                </span>
              </a>
            </li>
          )
        })}
      </ul>
    )
  }
  return (
    <Card icon={Clock} title="Recent changes">
      {body}
    </Card>
  )
}

interface PinnedCache {
  /** Cached text per pinned repo, in characters (close to bytes for code). */
  sizes: ReadonlyMap<string, number>
  /** Repos the last sync covered. */
  synced: readonly string[]
  syncedAt: string | null
}

/** What this device holds for the pinned repos; null until read, or when there is no IndexedDB. */
function usePinnedCache(pins: readonly string[]): PinnedCache | null {
  const [cache, setCache] = useState<PinnedCache | null>(null)
  useEffect(() => {
    if (typeof indexedDB === 'undefined' || pins.length === 0) return
    let live = true
    const db = offlineDb()
    void (async () => {
      try {
        const sizes = new Map<string, number>()
        for (const name of pins.slice(0, PINNED_SHOWN)) {
          let total = 0
          await db.documents
            .where('[sourceKind+sourceName]')
            .equals(['repo', name])
            .each((doc) => {
              total += doc.content.length
            })
          sizes.set(name, total)
        }
        const state = await readSyncState(db)
        if (live) setCache({ sizes, synced: state?.repos ?? [], syncedAt: state?.syncedAt ?? null })
      } catch {
        // Unreadable cache: the rows show without sizes.
      }
    })()
    return () => {
      live = false
    }
  }, [pins])
  return cache
}

function PinnedOffline({ timeZone, now }: { timeZone: string; now: number }) {
  const pins = usePinnedRepos()
  const cache = usePinnedCache(pins)
  const reposPath = pathFor('repos')
  return (
    <Card icon={Pin} title="Pinned offline" action={<CardLink path={pathFor('pinned')}>Manage</CardLink>}>
      {pins.length === 0 ? (
        <CardNote>
          No repos pinned yet.{' '}
          <a
            href={reposPath}
            onClick={(event) => followLink(event, reposPath)}
            className="font-medium text-accent-ink underline underline-offset-4"
          >
            Pin a repo
          </a>{' '}
          to search it offline.
        </CardNote>
      ) : (
        <ul className="space-y-0.5">
          {pins.slice(0, PINNED_SHOWN).map((name) => {
            const size = cache?.sizes.get(name) ?? 0
            const syncedAt = cache !== null && cache.synced.includes(name) ? cache.syncedAt : null
            const path = pathFor('pinned')
            return (
              <li key={name}>
                <a
                  href={path}
                  onClick={(event) => followLink(event, path)}
                  className={`${rowClass} flex items-center gap-2.5`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {syncedAt === null
                        ? 'Repo · not cached yet'
                        : `Repo · synced ${timeAgo(syncedAt, now, timeZone)}`}
                    </span>
                  </span>
                  {size > 0 ? (
                    <span className="shrink-0 rounded-full bg-raised px-2 py-0.5 text-xs text-muted">
                      {formatBytes(size)}
                    </span>
                  ) : null}
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function TryAsking({ online, onAsk }: { online: boolean; onAsk: (question: string) => void }) {
  const state = useServerData(online, loadRecentQuestions)
  if (state.status === 'loading') {
    return (
      <Card icon={Sparkles} title="Try asking">
        <CardNote>Loading…</CardNote>
      </Card>
    )
  }
  // Until there is a question of the owner's (or while it can't be loaded), the fixed examples.
  const asked = state.status === 'ready' ? state.value.map((entry) => entry.query).slice(0, QUESTIONS_SHOWN) : []
  const questions = asked.length > 0 ? asked : TRY_ASKING_EXAMPLES
  return (
    <Card icon={Sparkles} title="Try asking">
      <ul className="space-y-0.5">
        {questions.map((question) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => onAsk(question)}
              className={`${rowClass} flex items-center gap-2 text-sm leading-snug`}
            >
              <span className="min-w-0 flex-1 break-words">{question}</span>
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The latest searches, on phones only (R14); hidden until there are some. */
function RecentSearches({ online, onSearch }: { online: boolean; onSearch: (query: string) => void }) {
  const state = useServerData(online, loadRecentSearches)
  if (state.status !== 'ready' || state.value.length === 0) return null
  return (
    <Card icon={History} title="Recent searches" className="md:hidden">
      <ul className="space-y-0.5">
        {state.value.slice(0, SEARCHES_SHOWN).map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              onClick={() => onSearch(entry.query)}
              className={`${rowClass} truncate text-sm`}
            >
              {entry.query}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export function HomeCards({
  online,
  timeZone,
  onAsk,
  onSearch,
}: {
  online: boolean
  timeZone: string
  onAsk: (question: string) => void
  onSearch: (query: string) => void
}) {
  // Ages ("2h ago") are measured from when Home opened, and move on each minute.
  const now = useNow()
  return (
    <div className="grid w-full gap-3.5 md:grid-cols-2 lg:grid-cols-3">
      <RecentSearches online={online} onSearch={onSearch} />
      <RecentChanges online={online} timeZone={timeZone} now={now} />
      <PinnedOffline timeZone={timeZone} now={now} />
      <TryAsking online={online} onAsk={onAsk} />
    </div>
  )
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

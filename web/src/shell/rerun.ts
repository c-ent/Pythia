import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RecentQuery, RecentQueryKind } from '../api/recent'
import { SOURCE_KINDS, type SourceKind } from '../api/search'
import { navigate, pathFor } from '../router'

// Running a recent search or question again (R14), from the sidebar or the
// phone Home card. The screen that runs it (Search for searches, Ask for
// questions) may not be mounted yet, so the request waits here until it is,
// the same way New search does (newSearch.ts).

export interface Rerun {
  query: string
  sources: SourceKind[]
}

const EVENT = 'pythia:rerun'
const waiting = new Map<RecentQueryKind, Rerun>()

const isSourceKind = (value: unknown): value is SourceKind =>
  typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value)

/** Opens the entry's screen and runs it there with the source filter it ran with. */
export function rerunQuery(entry: Pick<RecentQuery, 'kind' | 'query' | 'filters'>): void {
  const sources = Array.isArray(entry.filters.sources) ? entry.filters.sources.filter(isSourceKind) : []
  waiting.set(entry.kind, { query: entry.query, sources })
  navigate(pathFor(entry.kind === 'ask' ? 'ask' : 'search'))
  window.dispatchEvent(new CustomEvent<RecentQueryKind>(EVENT, { detail: entry.kind }))
}

/** Runs `onRun` for each rerun of `kind`, including one requested just before mounting. */
export function useRerun(kind: RecentQueryKind, onRun: (rerun: Rerun) => void): void {
  const latest = useRef(onRun)
  useLayoutEffect(() => {
    latest.current = onRun
  })
  useEffect(() => {
    const take = (): void => {
      const next = waiting.get(kind)
      if (next === undefined) return
      waiting.delete(kind)
      latest.current(next)
    }
    take()
    const onEvent = (event: Event): void => {
      if ((event as CustomEvent<RecentQueryKind>).detail === kind) take()
    }
    window.addEventListener(EVENT, onEvent)
    return () => window.removeEventListener(EVENT, onEvent)
  }, [kind])
}

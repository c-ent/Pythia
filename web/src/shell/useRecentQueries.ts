import { useCallback, useEffect, useState } from 'react'
import {
  clearRecentQueries,
  getRecentQueries,
  RECENT_QUERIES_CHANGED,
  recentQueriesChanged,
  removeRecentQuery,
  type RecentQuery,
  type RecentQueryKind,
} from '../api/recent'

export type RecentQueriesStatus = 'loading' | 'ready' | 'error' | 'offline'

export interface RecentQueriesState {
  status: RecentQueriesStatus
  queries: RecentQuery[]
  /** Set when the last remove or clear failed; the list is reloaded from the server. */
  actionError: string | null
  remove: (id: number) => void
  clear: () => void
}

/**
 * One of the owner's recent lists (R14), shared by every device. It reloads
 * whenever a search or question runs, or an entry is removed or cleared, here
 * or in another list of the same kind. Nothing loads while offline. Use one
 * instance per kind (give the component a `key` of the kind).
 */
export function useRecentQueries(kind: RecentQueryKind, limit: number, online: boolean): RecentQueriesState {
  const [version, setVersion] = useState(0)
  const [loaded, setLoaded] = useState<{ status: 'loading' | 'ready' | 'error'; queries: RecentQuery[] }>({
    status: 'loading',
    queries: [],
  })
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const onChange = (event: Event): void => {
      if ((event as CustomEvent<RecentQueryKind>).detail === kind) setVersion((n) => n + 1)
    }
    window.addEventListener(RECENT_QUERIES_CHANGED, onChange)
    return () => window.removeEventListener(RECENT_QUERIES_CHANGED, onChange)
  }, [kind])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getRecentQueries(kind, limit, controller.signal).then(
      (queries) => {
        if (!controller.signal.aborted) setLoaded({ status: 'ready', queries })
      },
      () => {
        // A failed reload keeps the list already shown.
        if (!controller.signal.aborted) setLoaded((prev) => (prev.status === 'ready' ? prev : { status: 'error', queries: [] }))
      },
    )
    return () => controller.abort()
  }, [kind, limit, online, version])

  const remove = useCallback(
    (id: number): void => {
      setActionError(null)
      setLoaded((prev) => ({ ...prev, queries: prev.queries.filter((entry) => entry.id !== id) }))
      removeRecentQuery(id).then(
        () => recentQueriesChanged(kind),
        () => {
          setActionError('Couldn’t remove it. Try again.')
          recentQueriesChanged(kind)
        },
      )
    },
    [kind],
  )

  const clear = useCallback((): void => {
    setActionError(null)
    setLoaded({ status: 'ready', queries: [] })
    clearRecentQueries(kind).then(
      () => recentQueriesChanged(kind),
      () => {
        setActionError('Couldn’t clear the list. Try again.')
        recentQueriesChanged(kind)
      },
    )
  }, [kind])

  if (!online) return { status: 'offline', queries: [], actionError: null, remove, clear }
  return { ...loaded, actionError, remove, clear }
}

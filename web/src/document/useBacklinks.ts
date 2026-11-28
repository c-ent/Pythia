import { useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { getBacklinks, type BacklinksResponse } from '../api/backlinks'
import { useOnline } from '../hooks/useOnline'
import { offlineBacklinks } from '../offline/offlineMap'

export type BacklinksState =
  /** Not a note (repo, Drive) or not opened yet: no request, no panel. */
  | { status: 'off' }
  | { status: 'offline' }
  | { status: 'loading' }
  | { status: 'done'; response: BacklinksResponse }
  | { status: 'error'; message: string }

type Fetched =
  | { status: 'loading' }
  | { status: 'offline' }
  | { status: 'done'; response: BacklinksResponse }
  | { status: 'error'; message: string }

function backlinksErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server, so backlinks can’t load.'
  return 'Couldn’t load backlinks.'
}

/** Guards against a server without the backlinks route answering with something else; `outgoing` may be missing. */
export function toBacklinksResponse(value: unknown): BacklinksResponse | null {
  if (value === null || typeof value !== 'object') return null
  const body = value as Record<string, unknown>
  if (typeof body.supported !== 'boolean' || !Array.isArray(body.backlinks)) return null
  return {
    supported: body.supported,
    backlinks: body.backlinks as BacklinksResponse['backlinks'],
    outgoing: Array.isArray(body.outgoing) ? (body.outgoing as BacklinksResponse['outgoing']) : [],
  }
}

/**
 * The opened note's backlinks and resolved outgoing links (R20, T69), read once
 * for both the Backlinks panel and the viewer's note links. Offline they are
 * resolved on the device from the synced link rows (T72), without passages;
 * `offline` means this device holds no copy of the note's rows.
 */
export function useBacklinks(id: number, enabled: boolean): { state: BacklinksState; retry: () => void } {
  const online = useOnline()
  const [fetched, setFetched] = useState<Fetched>({ status: 'loading' })
  // Bumped by Retry; each value loads the list again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    if (!online) {
      // Offline: resolved from the synced copy's link rows (T72), without passages.
      offlineBacklinks(id)
        .then((response) => {
          if (!controller.signal.aborted) setFetched(response === null ? { status: 'offline' } : { status: 'done', response })
        })
        .catch(() => {
          if (!controller.signal.aborted) setFetched({ status: 'offline' })
        })
      return () => controller.abort()
    }
    getBacklinks(id, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return
        const response = toBacklinksResponse(body)
        setFetched(response === null ? { status: 'error', message: backlinksErrorMessage(null) } : { status: 'done', response })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFetched({ status: 'error', message: backlinksErrorMessage(error) })
      })
    return () => controller.abort()
  }, [id, enabled, online, attempt])

  const retry = (): void => {
    setFetched({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  if (!enabled) return { state: { status: 'off' }, retry }
  return { state: fetched, retry }
}

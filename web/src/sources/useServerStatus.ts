import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../api/client'
import { GEMINI_CHANGED } from '../api/gemini'
import { getStatus, STATUS_CHANGED, SYNC_POLL_MS, type ServerStatus } from '../api/status'

export interface ServerStatusState {
  /** The last status read, or null until one arrives. Kept when a later read fails. */
  status: ServerStatus | null
  /** The last read's error, or null after a successful one. */
  error: unknown
  /** False after the server could not be reached, true after it answered, undefined before either. */
  reachable: boolean | undefined
  /** The first read is under way. */
  loading: boolean
  reload: () => void
}

export interface ServerStatusOptions {
  /** Poll every `SYNC_POLL_MS` while the server reports a run (Sources and sync). */
  pollWhileSyncing?: boolean
  /** Reread this often while online (the top bar keeps its reachability current). */
  refreshMs?: number
}

/** A run started by Sync now or Re-sync is on, for the whole server or one source. */
export const serverSyncing = (status: ServerStatus | null): boolean =>
  status !== null && (status.syncing || status.sources.some((source) => source.syncing))

/**
 * `GET /api/status` (R18), read on mount, on reconnecting, on `STATUS_CHANGED`
 * and `GEMINI_CHANGED`, and as the options say. Offline nothing is read and
 * the last status stays.
 */
export function useServerStatus(online: boolean, options: ServerStatusOptions = {}): ServerStatusState {
  const { pollWhileSyncing = false, refreshMs } = options
  const [state, setState] = useState<Omit<ServerStatusState, 'reload' | 'loading'> & { loaded: boolean }>({
    status: null,
    error: null,
    reachable: undefined,
    loaded: false,
  })
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((n) => n + 1), [])

  useEffect(() => {
    window.addEventListener(STATUS_CHANGED, reload)
    window.addEventListener(GEMINI_CHANGED, reload)
    return () => {
      window.removeEventListener(STATUS_CHANGED, reload)
      window.removeEventListener(GEMINI_CHANGED, reload)
    }
  }, [reload])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getStatus(controller.signal).then(
      (status) => {
        if (!controller.signal.aborted) setState({ status, error: null, reachable: true, loaded: true })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setState((current) => ({
          status: current.status,
          error,
          // Any answer from the server, even an error, means it is reachable.
          reachable: error instanceof ApiError ? error.status !== 0 : current.reachable,
          loaded: true,
        }))
      },
    )
    return () => controller.abort()
  }, [online, version])

  const syncing = pollWhileSyncing && serverSyncing(state.status)
  useEffect(() => {
    if (!online) return
    const ms = syncing ? SYNC_POLL_MS : refreshMs
    if (ms === undefined) return
    const timer = window.setTimeout(reload, ms)
    return () => window.clearTimeout(timer)
  }, [online, syncing, refreshMs, reload, state])

  return {
    status: state.status,
    error: state.error,
    reachable: state.reachable,
    loading: online && !state.loaded,
    reload,
  }
}

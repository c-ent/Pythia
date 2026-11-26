import { useCallback, useEffect, useState } from 'react'
import { getSession, logout, onSignedOut } from '../api/client'
import { offlineDb } from '../offline/db'
import { clearOfflineCache } from '../offline/sync'

export type SessionState = 'checking' | 'signed-in' | 'signed-out' | 'unreachable'

export interface Session {
  state: SessionState
  signedIn: () => void
  signOut: () => Promise<void>
  recheck: () => void
}

/** Asks the server once on load, then follows logins, logouts and expired sessions. */
export function useSession(): Session {
  const [state, setState] = useState<SessionState>('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    getSession().then(
      (ok) => {
        if (live) setState(ok ? 'signed-in' : 'signed-out')
      },
      () => {
        if (live) setState('unreachable')
      },
    )
    return () => {
      live = false
    }
  }, [attempt])

  useEffect(() => onSignedOut(() => setState('signed-out')), [])

  const signedIn = useCallback(() => setState('signed-in'), [])
  const recheck = useCallback(() => {
    setState('checking')
    setAttempt((n) => n + 1)
  }, [])
  const signOut = useCallback(async () => {
    try {
      await logout()
    } catch {
      // Offline or server down: the cookie may outlive this, but the screen
      // still locks; the next request revalidates it.
    }
    // Cached note text must not outlive the session on a shared device.
    if (typeof indexedDB !== 'undefined') await clearOfflineCache(offlineDb()).catch(() => {})
    setState('signed-out')
  }, [])

  return { state, signedIn, signOut, recheck }
}

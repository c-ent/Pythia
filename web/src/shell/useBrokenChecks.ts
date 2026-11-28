import { useEffect, useState } from 'react'
import { getServerStatusDetails, serverCheckLabel } from '../api/serverStatus'

/**
 * Fetches `/api/status/server` only while `broken` is true so normal top-bar
 * polls never load full server metrics; returns human-readable names of the
 * broken checks for screen readers.
 */
export function useBrokenChecks(broken: boolean, checkedAt: string | undefined): string[] {
  const [state, setState] = useState<{ checkedAt: string | undefined; checks: string[] } | null>(null)

  useEffect(() => {
    if (!broken) return
    const controller = new AbortController()
    getServerStatusDetails(controller.signal).then(
      (details) => {
        if (controller.signal.aborted) return
        const checks = Object.entries(details.checks)
          .filter(([, check]) => check.state === 'broken')
          .map(([name]) => serverCheckLabel(name))
        setState({ checkedAt, checks })
      },
      () => {
        if (!controller.signal.aborted) setState({ checkedAt, checks: [] })
      },
    )
    return () => controller.abort()
  }, [broken, checkedAt])

  if (!broken) return []
  return state !== null && state.checkedAt === checkedAt ? state.checks : []
}

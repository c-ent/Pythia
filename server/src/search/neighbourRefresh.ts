import type { RefreshResult } from '../db/neighbourStore.js'
import type { ActivityKind, ActivityLog } from '../sync/activity.js'

/**
 * Runs the semantic neighbour refresh (R20, T66) after index rounds. Requests
 * that arrive while a refresh runs are folded into one more run afterwards,
 * so a burst of watcher batches costs at most two refreshes. The refresh
 * itself finds what changed from `document_vectors` (see neighbourStore.ts),
 * so a missed or failed request is caught up by the next one.
 */
export interface NeighbourRefresher {
  /** Starts a refresh, or queues one when a refresh is running. Never throws. */
  request(): void
  /** Resolves when no refresh is running or queued. */
  idle(): Promise<void>
}

export interface NeighbourRefresherOptions {
  /** Counts only. */
  log?: (message: string) => void
}

export function createNeighbourRefresher(
  refresh: () => Promise<RefreshResult>,
  options: NeighbourRefresherOptions = {},
): NeighbourRefresher {
  const log = options.log ?? ((message: string) => console.log(message))
  let running: Promise<void> | null = null
  let again = false

  const loop = async (): Promise<void> => {
    do {
      again = false
      try {
        const result = await refresh()
        if (result.refreshed > 0 || result.failed > 0) {
          log(`map: neighbours refreshed for ${result.refreshed} documents${result.failed > 0 ? `, ${result.failed} failed` : ''}`)
        }
      } catch (error) {
        log(`map: neighbour refresh failed (${error instanceof Error ? error.name : 'unknown'})`)
      }
    } while (again)
  }

  return {
    request() {
      if (running !== null) {
        again = true
        return
      }
      running = loop().finally(() => {
        running = null
      })
    },
    async idle() {
      while (running !== null) await running
    },
  }
}

/**
 * Events that end an index round: vault scan or batch, repo round or re-sync,
 * Keep import, Drive round, and a failed round (`sync_error`), which may
 * still have indexed some documents before it stopped.
 */
export const ROUND_KINDS: ReadonlySet<ActivityKind> = new Set([
  'vault_synced',
  'repos_fetched',
  'repo_fetched',
  'keep_imported',
  'drive_pulled',
  'sync_error',
])

/**
 * Every indexer (vault, repos, Keep, Drive) records an event when a round
 * ends, so the activity log is the one place that sees all of them. This
 * wraps it: the event is recorded as before, then a neighbour refresh is
 * requested. A refresh with nothing changed is one query.
 */
export function refreshAfterRounds(activity: ActivityLog, refresher: NeighbourRefresher): ActivityLog {
  return {
    ...activity,
    async record(event) {
      await activity.record(event)
      if (ROUND_KINDS.has(event.kind)) refresher.request()
    },
  }
}

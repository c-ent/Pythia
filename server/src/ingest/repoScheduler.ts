import type { RepoSpec } from './repoConfig.js'
import { syncRepo, type MirrorOptions, type SyncResult } from './repoMirror.js'

/**
 * Fetches every configured repo on a fixed interval (R9: every 30 minutes).
 * Repos sync one at a time, a round never overlaps the previous one, and one
 * repo failing never stops the others. `onSynced` receives each repo's new
 * commit; the repo pipeline (T17) indexes from there.
 */

export const DEFAULT_FETCH_INTERVAL_MS = 30 * 60_000

export interface RepoRoundResult {
  synced: SyncResult[]
  /** Repo names and a redacted reason; never URLs with credentials or file content. */
  failed: Array<{ name: string; error: string }>
}

export interface RepoSchedulerOptions extends MirrorOptions {
  repos: readonly RepoSpec[]
  intervalMs?: number
  onSynced?: (result: SyncResult, spec: RepoSpec) => Promise<void> | void
  /** Called after each round; defaults to a count-only log line. */
  onRound?: (result: RepoRoundResult) => void
  /** Injected for tests. */
  sync?: typeof syncRepo
}

export interface RepoScheduler {
  /** Runs a round now, or waits for the one in progress. */
  runNow(): Promise<RepoRoundResult>
  close(): Promise<void>
}

export function startRepoScheduler(options: RepoSchedulerOptions): RepoScheduler {
  const sync = options.sync ?? syncRepo
  const intervalMs = options.intervalMs ?? DEFAULT_FETCH_INTERVAL_MS
  const onRound =
    options.onRound ??
    ((result: RepoRoundResult) =>
      console.log('repo fetch round', {
        synced: result.synced.length,
        cloned: result.synced.filter((repo) => repo.cloned).length,
        failed: result.failed.map((failure) => failure.name),
      }))

  let closed = false
  let current: Promise<RepoRoundResult> | null = null
  let timer: NodeJS.Timeout | null = null

  async function round(): Promise<RepoRoundResult> {
    const result: RepoRoundResult = { synced: [], failed: [] }
    for (const spec of options.repos) {
      if (closed) break
      try {
        const synced = await sync(spec, options)
        result.synced.push(synced)
        await options.onSynced?.(synced, spec)
      } catch (error) {
        result.failed.push({ name: spec.name, error: error instanceof Error ? error.message : 'unknown error' })
      }
    }
    onRound(result)
    return result
  }

  function runNow(): Promise<RepoRoundResult> {
    if (current === null) {
      current = round().finally(() => {
        current = null
        schedule()
      })
    }
    return current
  }

  function schedule(): void {
    if (closed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => void runNow(), intervalMs)
    timer.unref()
  }

  if (options.repos.length > 0) void runNow()

  return {
    runNow,
    async close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      await current
    },
  }
}

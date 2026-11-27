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
  /**
   * Called after each round; defaults to a count-only log line. Not called for
   * `runOne`. A returned promise is awaited; its value is ignored.
   */
  onRound?: (result: RepoRoundResult) => unknown
  /** Called after each `runOne` fetch, once however many callers asked for it. */
  onSingle?: (name: string, result: RepoRoundResult) => unknown
  /** Called with the error of each repo that failed to fetch or index, in a round or in `runOne`. */
  onFailed?: (spec: RepoSpec, error: unknown) => void
  /** Injected for tests. */
  sync?: typeof syncRepo
}

export interface RepoScheduler {
  /** Runs a round now, or waits for the one in progress. */
  runNow(): Promise<RepoRoundResult>
  /**
   * Fetches and indexes one repo, after any round or single fetch already
   * running, so a mirror is never fetched twice at once. The same repo asked
   * for again while queued or running gets the same promise. Null for a repo
   * that is not configured.
   */
  runOne(name: string): Promise<RepoRoundResult> | null
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
  const singles = new Map<string, Promise<RepoRoundResult>>()
  let timer: NodeJS.Timeout | null = null
  // Rounds and single fetches take turns: two git processes on one mirror would fight over its lock.
  let lock: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = lock.then(task)
    lock = next.catch(() => undefined)
    return next
  }

  async function syncOne(spec: RepoSpec, result: RepoRoundResult): Promise<void> {
    try {
      const synced = await sync(spec, options)
      result.synced.push(synced)
      await options.onSynced?.(synced, spec)
    } catch (error) {
      result.failed.push({ name: spec.name, error: error instanceof Error ? error.message : 'unknown error' })
      options.onFailed?.(spec, error)
    }
  }

  async function round(): Promise<RepoRoundResult> {
    const result: RepoRoundResult = { synced: [], failed: [] }
    for (const spec of options.repos) {
      if (closed) break
      await syncOne(spec, result)
    }
    await report(() => onRound(result))
    return result
  }

  /** A failing report hook is logged by class and never turns a round into a failure. */
  async function report(hook: () => unknown): Promise<void> {
    try {
      await hook()
    } catch (error) {
      console.error(`repo round report failed: ${error instanceof Error ? error.name : 'unknown'}`)
    }
  }

  function runNow(): Promise<RepoRoundResult> {
    if (current === null) {
      current = exclusive(round).finally(() => {
        current = null
        schedule()
      })
    }
    return current
  }

  function runOne(name: string): Promise<RepoRoundResult> | null {
    const spec = options.repos.find((candidate) => candidate.name === name)
    if (spec === undefined) return null
    const running = singles.get(name)
    if (running !== undefined) return running
    const single = exclusive(async () => {
      const result: RepoRoundResult = { synced: [], failed: [] }
      if (closed) return result
      await syncOne(spec, result)
      await report(() => options.onSingle?.(name, result))
      return result
    }).finally(() => {
      singles.delete(name)
    })
    singles.set(name, single)
    return single
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
    runOne,
    async close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      await current
      await Promise.allSettled([...singles.values()])
    },
  }
}

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
  /**
   * Repo discovery (T54): run at the start of every round, before any fetch.
   * Returns repos to add; they are fetched and indexed in that same round and
   * kept for later rounds. Repos are only ever added, never removed. With a
   * `discover` hook the startup round runs even when no repo is configured.
   */
  discover?: (current: readonly RepoSpec[]) => Promise<RepoSpec[]>
  /** Called with the repos `discover` added, before they are fetched. */
  onDiscovered?: (added: readonly RepoSpec[]) => void
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
  /**
   * `running`: a round is queued or running, whoever started it (startup, the
   * interval timer or `runNow`). `repo`: the repo being fetched or indexed
   * right now, in a round or a single fetch; null between repos.
   */
  state(): { running: boolean; repo: string | null }
  /** Live progress during a round or single fetch, or null when idle. */
  progress(): { stage: 'fetching' | 'indexing'; done: number; total: number; item: string | null } | null
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
  // Configured repos, plus any discovery adds (T54). Only ever grows.
  const specs: RepoSpec[] = [...options.repos]
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

  // Only one repo is ever fetched at a time (see `exclusive`), so one name is enough.
  let active: string | null = null
  let progress: { stage: 'fetching' | 'indexing'; done: number; total: number; item: string | null } | null = null

  async function syncOne(spec: RepoSpec, result: RepoRoundResult, done: number, total: number): Promise<void> {
    active = spec.name
    progress = { stage: 'fetching', done, total, item: spec.name }
    try {
      const synced = await sync(spec, options)
      result.synced.push(synced)
      progress = { stage: 'indexing', done, total, item: spec.name }
      await options.onSynced?.(synced, spec)
    } catch (error) {
      result.failed.push({ name: spec.name, error: error instanceof Error ? error.message : 'unknown error' })
      options.onFailed?.(spec, error)
    } finally {
      active = null
    }
  }

  async function round(): Promise<RepoRoundResult> {
    const result: RepoRoundResult = { synced: [], failed: [] }
    await discoverNew()
    const snapshot = [...specs]
    let done = 0
    try {
      for (const spec of snapshot) {
        if (closed) break
        await syncOne(spec, result, done, snapshot.length)
        done++
      }
    } finally {
      progress = null
    }
    await report(() => onRound(result))
    return result
  }

  /** Adds the repos discovery found; a failing hook never stops the round. */
  async function discoverNew(): Promise<void> {
    if (options.discover === undefined || closed) return
    let added: RepoSpec[]
    try {
      added = await options.discover(specs)
    } catch (error) {
      console.error(`repo discovery failed: ${error instanceof Error ? error.name : 'unknown'}`)
      return
    }
    const known = new Set(specs.map((spec) => spec.name.toLowerCase()))
    const fresh = added.filter((spec) => {
      const key = spec.name.toLowerCase()
      if (known.has(key)) return false
      known.add(key)
      return true
    })
    if (fresh.length === 0) return
    specs.push(...fresh)
    options.onDiscovered?.(fresh)
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
    const spec = specs.find((candidate) => candidate.name === name)
    if (spec === undefined) return null
    const running = singles.get(name)
    if (running !== undefined) return running
    const single = exclusive(async () => {
      const result: RepoRoundResult = { synced: [], failed: [] }
      if (closed) return result
      try {
        await syncOne(spec, result, 0, 1)
      } finally {
        progress = null
      }
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

  if (specs.length > 0 || options.discover !== undefined) void runNow()

  return {
    runNow,
    runOne,
    state: () => ({ running: current !== null, repo: active }),
    progress: () => progress,
    async close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      await current
      await Promise.allSettled([...singles.values()])
    },
  }
}

/**
 * "Sync now" (R18, T42): a vault re-scan and a fetch of every repo, started
 * in the background so `POST /api/sync-now` answers at once. A run already in
 * progress is never started twice; pressing again while it runs reports that.
 * The scans and fetches record their own activity events (startVault,
 * startRepos); this module only starts them and logs an error class.
 */

/** `running`: the run already in progress covers it. `off`: not configured on this server. */
export type SyncPart = 'started' | 'running' | 'off'

export interface SyncNowStart {
  /** False when a run was already in progress; nothing new was started. */
  started: boolean
  vault: SyncPart
  repos: SyncPart
  /** The Drive pull and index (R19, T61). `running` also when a scheduled Drive round already covers it. */
  drive: SyncPart
}

export type RepoSyncStart = 'started' | 'running' | 'not_found' | 'off'

export interface SyncNowService {
  /** Starts a run unless one is in progress. */
  syncNow(): SyncNowStart
  /** Starts a fetch of one configured repo unless that repo's fetch is already queued or running. */
  syncRepo(name: string): RepoSyncStart
  /** Whether a Sync now run is in progress, and which single repos are being fetched. */
  state(): { running: boolean; repos: string[] }
  /** Resolves when the current run and every single fetch have finished (shutdown, tests). */
  idle(): Promise<void>
}

export interface SyncNowOptions {
  /** Full vault scan; absent when the vault is off. */
  vault?: () => Promise<unknown>
  /** Fetch and index round over every repo; absent when repos are off. */
  repos?: () => Promise<unknown>
  /** Fetches one repo; null for a name not in the config. Absent when repos are off. */
  repo?: (name: string) => Promise<unknown> | null
  /**
   * Drive round (pull, then index); absent when Drive is off. It joins a
   * round already in progress rather than starting a second one.
   */
  drive?: () => Promise<unknown>
  /** Error classes only: messages can quote paths, git or rclone output. */
  log?: (message: string) => void
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

export function createSyncNow(options: SyncNowOptions): SyncNowService {
  const log = options.log ?? ((message: string) => console.error(message))
  let current: Promise<void> | null = null
  const singles = new Map<string, Promise<void>>()

  const guarded = async (name: string, task: () => Promise<unknown> | null): Promise<void> => {
    try {
      await task()
    } catch (error) {
      log(`sync now: ${name} failed: ${errorName(error)}`)
    }
  }

  return {
    syncNow() {
      const part = (task: (() => Promise<unknown>) | undefined): SyncPart =>
        task === undefined ? 'off' : current === null ? 'started' : 'running'
      const parts = { vault: part(options.vault), repos: part(options.repos), drive: part(options.drive) }
      if (current !== null) return { started: false, ...parts }
      const tasks: Array<Promise<void>> = []
      // The vault, the repos and Drive are independent; run them side by side.
      if (options.vault !== undefined) tasks.push(guarded('vault', options.vault))
      if (options.repos !== undefined) tasks.push(guarded('repos', options.repos))
      if (options.drive !== undefined) tasks.push(guarded('drive', options.drive))
      const run = Promise.all(tasks).then(() => {
        current = null
      })
      current = run
      return { started: true, ...parts }
    },

    syncRepo(name) {
      const fetchOne = options.repo
      if (fetchOne === undefined) return 'off'
      if (singles.has(name)) return 'running'
      let task: Promise<unknown> | null
      try {
        task = fetchOne(name)
      } catch (error) {
        log(`sync now: repo failed: ${errorName(error)}`)
        return 'started'
      }
      if (task === null) return 'not_found'
      const single = guarded('repo', () => task).then(() => {
        singles.delete(name)
      })
      singles.set(name, single)
      return 'started'
    },

    state() {
      return { running: current !== null, repos: [...singles.keys()].sort() }
    },

    async idle() {
      await current
      await Promise.all([...singles.values()])
    },
  }
}

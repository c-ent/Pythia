import type { DriveIndexResult } from '../ingest/driveIndexer.js'
import type { IndexResult } from '../ingest/vaultIndexer.js'
import { logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'

/**
 * Sync activity (R18, T42): the last 50 events shown on Sources and sync.
 * An event carries a kind, a source name, a count and at most a short fixed
 * reason (an error class, "3 failed"). Never note text, file content, file
 * paths or secret values: blocked secrets are a count only.
 */

export const ACTIVITY_KINDS = [
  'vault_synced',
  'repos_fetched',
  'repo_fetched',
  'secrets_blocked',
  'keep_imported',
  'sync_error',
  'drive_pulled',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** Rows kept in the `activity` table; older ones are deleted with each insert. */
export const MAX_ACTIVITY = 50
/** Longest `source` and `message`; reasons are short phrases, so this only guards against mistakes. */
export const MAX_ACTIVITY_TEXT = 200

/** Source names used in events. A single repo uses its configured name. */
export const VAULT_SOURCE = 'obsidian'
export const REPOS_SOURCE = 'github'
export const KEEP_SOURCE = 'keep'
export const DRIVE_SOURCE = 'gdrive'

export interface NewActivity {
  kind: ActivityKind
  source: string | null
  count?: number | null
  message?: string | null
}

export interface ActivityEvent {
  id: number
  at: Date
  kind: ActivityKind
  source: string | null
  count: number | null
  message: string | null
}

export interface ActivityStore {
  /** Inserts one event and deletes all but the newest `keep`, in one transaction. */
  record(event: Omit<ActivityEvent, 'id'>, keep: number): Promise<void>
  /** Newest first. */
  list(limit: number): Promise<ActivityEvent[]>
}

export interface ActivityLog {
  /** Never throws: a failed write is logged by error class and dropped, so syncing never stops for it. */
  record(event: NewActivity): Promise<void>
  /** The last `MAX_ACTIVITY` events, newest first. */
  list(): Promise<ActivityEvent[]>
  /** Notes a successful sync of `source` without an event (each repo of a round). */
  markSynced(source: string): void
  /**
   * Last successful sync of `source` seen by this process, so a quiet source
   * keeps its time after its events were trimmed away.
   */
  lastSynced(source: string): Date | null
}

export interface ActivityLogOptions {
  now?: () => number
  onError?: (error: unknown) => void
}

const SUCCESS_KINDS: ReadonlySet<ActivityKind> = new Set([
  'vault_synced',
  'repos_fetched',
  'repo_fetched',
  'keep_imported',
  'drive_pulled',
])

const clip = (text: string | null | undefined): string | null => (text == null ? null : text.slice(0, MAX_ACTIVITY_TEXT))

export function createActivityLog(store: ActivityStore, options: ActivityLogOptions = {}): ActivityLog {
  const now = options.now ?? Date.now
  const onError =
    options.onError ??
    ((error: unknown) => console.error(`activity not recorded: ${error instanceof Error ? error.name : 'unknown'}`))
  const synced = new Map<string, Date>()
  return {
    async record(event) {
      const at = new Date(now())
      if (event.source !== null && SUCCESS_KINDS.has(event.kind)) synced.set(event.source, at)
      try {
        await store.record(
          { at, kind: event.kind, source: clip(event.source), count: event.count ?? null, message: clip(event.message) },
          MAX_ACTIVITY,
        )
      } catch (error) {
        onError(error)
      }
    },
    list: () => store.list(MAX_ACTIVITY),
    markSynced(source) {
      synced.set(source, new Date(now()))
    },
    lastSynced(source) {
      return synced.get(source) ?? null
    },
  }
}

/** A short reason for a failure: the error class only, since messages can quote paths or remote output. */
export function errorReason(context: string, error: unknown): string {
  const name = error instanceof Error && error.name !== '' ? error.name : 'unknown error'
  return `${context}: ${name}`
}

export const syncErrorEvent = (source: string, context: string, error: unknown): NewActivity => ({
  kind: 'sync_error',
  source,
  message: errorReason(context, error),
})

const REPO_ERROR_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/needed a single revision|unknown revision|does not have any commits/i, 'empty repo (no commits)'],
  [/remote branch .* not found|couldn't find remote ref/i, 'branch not found'],
  [
    /authentication failed|could not read username|permission denied|invalid username or token|\b(?:401|403)\b/i,
    'authentication failed',
  ],
  [
    /repository .* not found|does not appear to be a git repository|could not read from remote repository/i,
    'repo not found or inaccessible',
  ],
  [/could not resolve host|failed to connect|timed out|etimedout|econnreset|\bssl\b|\btls\b/i, 'network error or timeout'],
  [/cannot lock ref|\.lock\b|not a git repository|corrupt/i, 'mirror lock or git error'],
]

/**
 * Maps a `RepoSyncError` to a fixed safe phrase so UI status and activity show
 * why a repo failed without quoting remote URLs, credentials or local paths.
 */
export function repoErrorReason(error: unknown): string {
  if (error instanceof Error && error.name === 'RepoSyncError') {
    for (const [pattern, label] of REPO_ERROR_PATTERNS) {
      if (pattern.test(error.message)) return label
    }
    const cmd = /^git ([a-z-]+) failed:/i.exec(error.message)
    if (cmd?.[1] !== undefined) return `git ${cmd[1]} failed`
  }
  return errorReason('fetch failed', error)
}

export const repoErrorEvent = (source: string, error: unknown): NewActivity => ({
  kind: 'sync_error',
  source,
  message: repoErrorReason(error),
})

/**
 * The events for one vault scan or watcher batch. A batch that changed
 * nothing records nothing (`always` is for full scans), so the watcher does
 * not push older events out.
 */
export function vaultRunEvents(result: IndexResult, options: { always?: boolean } = {}): NewActivity[] {
  if (result.keptEmptyVault === true) {
    return [{ kind: 'sync_error', source: VAULT_SOURCE, message: 'vault folder is empty; index kept' }]
  }
  const changed = result.indexed.length + result.deleted.length
  const failed = result.failed.length
  if (changed === 0 && failed === 0 && options.always !== true) return []
  return [{ kind: 'vault_synced', source: VAULT_SOURCE, count: changed, message: failed > 0 ? `${failed} failed` : null }]
}

export interface SecretsTally {
  /** Pass to an indexer as `logSecrets`: logs `{ file, droppedCount }` and adds up the count. */
  logger: SecretsDropLogger
  /** The count since the last `take`, and resets it. */
  take(): number
}

export function createSecretsTally(log: SecretsDropLogger = logSecretsDrop): SecretsTally {
  let count = 0
  return {
    logger(event) {
      count += event.droppedCount
      log(event)
    },
    take() {
      const taken = count
      count = 0
      return taken
    },
  }
}

/** A `secrets_blocked` event for the tally, or none when nothing was blocked. */
export function secretsEvents(source: string, tally: SecretsTally): NewActivity[] {
  const count = tally.take()
  return count > 0 ? [{ kind: 'secrets_blocked', source, count }] : []
}

export async function recordAll(activity: ActivityLog | undefined, events: readonly NewActivity[]): Promise<void> {
  if (activity === undefined) return
  for (const event of events) await activity.record(event)
}

/** Records the vault's scans and watcher batches (startVault). */
export interface VaultActivity {
  /** Pass to the vault indexer. */
  logSecrets: SecretsDropLogger
  /** Runs a full scan and records it; a failure is recorded and rethrown. */
  scan(task: () => Promise<IndexResult>): Promise<IndexResult>
  /** The watcher's `onResult`. */
  batch(result: IndexResult): Promise<void>
  /** The watcher's `onError`. */
  batchError(error: unknown): Promise<void>
}

export function createVaultActivity(activity: ActivityLog | undefined, log?: SecretsDropLogger): VaultActivity {
  const tally = createSecretsTally(log)
  return {
    logSecrets: tally.logger,
    async scan(task) {
      try {
        const result = await task()
        await recordAll(activity, [...vaultRunEvents(result, { always: true }), ...secretsEvents(VAULT_SOURCE, tally)])
        return result
      } catch (error) {
        await recordAll(activity, [...secretsEvents(VAULT_SOURCE, tally), syncErrorEvent(VAULT_SOURCE, 'scan failed', error)])
        throw error
      }
    },
    async batch(result) {
      await recordAll(activity, [...vaultRunEvents(result), ...secretsEvents(VAULT_SOURCE, tally)])
    },
    async batchError(error) {
      await recordAll(activity, [...secretsEvents(VAULT_SOURCE, tally), syncErrorEvent(VAULT_SOURCE, 'sync failed', error)])
    },
  }
}

/** What a repo fetch round or single fetch reports (`RepoRoundResult` from the scheduler). */
export interface RepoRunResult {
  synced: ReadonlyArray<{ name: string }>
  failed: ReadonlyArray<{ name: string }>
}

/** Records repo fetch rounds and single re-syncs (startRepos). */
export interface RepoActivity {
  /** Pass to the repo indexer. */
  logSecrets: SecretsDropLogger
  /** The scheduler's `onFailed`: keeps the error so its class can be recorded. */
  failed(name: string, error: unknown): void
  /** The scheduler's `onRound`. */
  round(result: RepoRunResult): Promise<void>
  /** The scheduler's `onSingle`. */
  single(name: string, result: RepoRunResult): Promise<void>
}

export function createRepoActivity(activity: ActivityLog | undefined, log?: SecretsDropLogger): RepoActivity {
  const tally = createSecretsTally(log)
  const errors = new Map<string, unknown>()
  const failure = (name: string): NewActivity => {
    const event = repoErrorEvent(name, errors.get(name))
    errors.delete(name)
    return event
  }
  return {
    logSecrets: tally.logger,
    failed(name, error) {
      errors.set(name, error)
    },
    async round(result) {
      for (const repo of result.synced) activity?.markSynced(repo.name)
      // The round first, then its failures, so each failure reads as newer than the round.
      await recordAll(activity, [
        {
          kind: 'repos_fetched',
          source: REPOS_SOURCE,
          count: result.synced.length,
          message: result.failed.length > 0 ? `${result.failed.length} failed` : null,
        },
        ...secretsEvents(REPOS_SOURCE, tally),
        ...result.failed.map((repo) => failure(repo.name)),
      ])
    },
    async single(name, result) {
      const failed = result.failed.some((repo) => repo.name === name)
      await recordAll(activity, [
        ...secretsEvents(name, tally),
        failed ? failure(name) : { kind: 'repo_fetched', source: name, count: 1 },
      ])
    },
  }
}

/** Fixed reason shown on Sources and sync when the Google login behind the Drive remote is revoked or expired. */
export const DRIVE_LOGIN_REASON = 'Drive login expired; renew it on the host'

/**
 * The event for one finished Drive round (pull, then index). `count` is the
 * documents indexed or removed; skipped and failed files are counts only.
 */
export function driveRunEvents(result: DriveIndexResult): NewActivity[] {
  if (result.keptEmptyMirror === true) {
    return [{ kind: 'sync_error', source: DRIVE_SOURCE, message: 'Drive mirror is empty; index kept' }]
  }
  const skipped = Object.values(result.skipped).reduce((sum, n) => sum + n, 0)
  const failed = result.failed.length
  const notes = [skipped > 0 ? `${skipped} skipped` : null, failed > 0 ? `${failed} failed` : null].filter(
    (note): note is string => note !== null,
  )
  return [
    {
      kind: 'drive_pulled',
      source: DRIVE_SOURCE,
      count: result.indexed.length + result.deleted.length,
      message: notes.length > 0 ? notes.join(', ') : null,
    },
  ]
}

/** A Drive round failure: the login phrase for an expired login, else the error class. */
export function driveErrorEvent(error: unknown): NewActivity {
  if (error instanceof Error && error.name === 'DriveLoginError') {
    return { kind: 'sync_error', source: DRIVE_SOURCE, message: DRIVE_LOGIN_REASON }
  }
  return syncErrorEvent(DRIVE_SOURCE, 'Drive round failed', error)
}

/** Records Drive rounds (startDrive). */
export interface DriveActivity {
  /** Pass to the Drive indexer. */
  logSecrets: SecretsDropLogger
  /** Runs one round and records it; a failure is recorded and rethrown. */
  round(task: () => Promise<DriveIndexResult>): Promise<DriveIndexResult>
}

export function createDriveActivity(activity: ActivityLog | undefined, log?: SecretsDropLogger): DriveActivity {
  const tally = createSecretsTally(log)
  return {
    logSecrets: tally.logger,
    async round(task) {
      try {
        const result = await task()
        await recordAll(activity, [...driveRunEvents(result), ...secretsEvents(DRIVE_SOURCE, tally)])
        return result
      } catch (error) {
        await recordAll(activity, [...secretsEvents(DRIVE_SOURCE, tally), driveErrorEvent(error)])
        throw error
      }
    },
  }
}

export type SyncState = 'healthy' | 'error'

export interface DerivedState {
  state: SyncState
  reason: string | null
  /** Last successful sync among the kept events; null when there is none. */
  lastSyncAt: Date | null
}

export interface DerivedSourceStates {
  vault: DerivedState
  keep: DerivedState
  drive: DerivedState
  /** The repo rounds as a whole: last round time. */
  repos: DerivedState
  repo: Map<string, DerivedState>
}

const healthy = (): DerivedState => ({ state: 'healthy', reason: null, lastSyncAt: null })

/**
 * Per-source state and last sync time from the kept events. The latest event
 * decides: a sync after an error clears it. A repo round counts as a sync of
 * every repo, except one whose `sync_error` follows the round; that repo
 * keeps the last sync time it had before the round.
 */
export function deriveSourceStates(events: readonly ActivityEvent[], repoNames: readonly string[]): DerivedSourceStates {
  const vault = healthy()
  const keep = healthy()
  const drive = healthy()
  const repos = healthy()
  const repo = new Map<string, DerivedState>(repoNames.map((name) => [name, healthy()]))
  let beforeRound = new Map<string, Date | null>()
  const ok = (state: DerivedState, at: Date) => Object.assign(state, { state: 'healthy', reason: null, lastSyncAt: at })
  const fail = (state: DerivedState, reason: string | null) => Object.assign(state, { state: 'error', reason })

  const oldestFirst = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id)
  for (const event of oldestFirst) {
    if (event.source === VAULT_SOURCE || event.source === KEEP_SOURCE) {
      const state = event.source === VAULT_SOURCE ? vault : keep
      if (event.kind === 'vault_synced' || event.kind === 'keep_imported') ok(state, event.at)
      else if (event.kind === 'sync_error') fail(state, event.message)
      continue
    }
    if (event.source === DRIVE_SOURCE) {
      if (event.kind === 'drive_pulled') ok(drive, event.at)
      else if (event.kind === 'sync_error') fail(drive, event.message)
      continue
    }
    if (event.kind === 'repos_fetched') {
      ok(repos, event.at)
      beforeRound = new Map()
      for (const [name, state] of repo) {
        beforeRound.set(name, state.lastSyncAt)
        ok(state, event.at)
      }
      continue
    }
    const name = event.source
    const state = name === null ? undefined : repo.get(name)
    if (name === null || state === undefined) continue
    if (event.kind === 'repo_fetched') {
      beforeRound.delete(name)
      ok(state, event.at)
    } else if (event.kind === 'sync_error') {
      if (beforeRound.has(name)) {
        state.lastSyncAt = beforeRound.get(name) ?? null
        beforeRound.delete(name)
      }
      fail(state, event.message)
    }
  }
  return { vault, keep, drive, repos, repo }
}

/** In-memory `ActivityStore` for tests; same trimming as the Postgres one. */
export function createMemoryActivityStore(): ActivityStore & { rows(): ActivityEvent[] } {
  let rows: ActivityEvent[] = []
  let nextId = 1
  const newestFirst = (a: ActivityEvent, b: ActivityEvent): number => b.at.getTime() - a.at.getTime() || b.id - a.id
  return {
    async record(event, keep) {
      rows.push({ ...event, id: nextId++ })
      rows = rows.sort(newestFirst).slice(0, keep)
    },
    async list(limit) {
      return rows.slice(0, limit).map((row) => ({ ...row }))
    },
    rows() {
      return rows.map((row) => ({ ...row }))
    },
  }
}

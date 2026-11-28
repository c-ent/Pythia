import type { SearchableKind } from '../db/searchStore.js'
import { SEARCHABLE_KINDS } from '../db/searchStore.js'
import type { StatusStore } from '../db/statusStore.js'
import {
  deriveSourceStates,
  DRIVE_SOURCE,
  KEEP_SOURCE,
  REPOS_SOURCE,
  VAULT_SOURCE,
  type ActivityEvent,
  type ActivityLog,
  type DerivedState,
} from './activity.js'

/**
 * `GET /api/status` (R18, T42): what Sources and sync, the Repos page, the
 * Pinned page and the top bar show about the server. States come from the
 * configuration (`off`), Keep being upload-only (`manual`) and the kept
 * activity events (`healthy` / `error`).
 */

export type SourceState = 'healthy' | 'error' | 'manual' | 'off'
export type SourceId = typeof VAULT_SOURCE | typeof REPOS_SOURCE | typeof KEEP_SOURCE | typeof DRIVE_SOURCE

/**
 * - `watch`: the vault watcher indexes changes as they arrive (plus a scan at start and on Sync now).
 * - `interval`: fetched every `everyMinutes` (repos, R9).
 * - `manual`: only on demand (Keep upload; a vault without the watcher: scan at start and on Sync now).
 * - `off`: not configured.
 */
export interface Schedule {
  kind: 'watch' | 'interval' | 'manual' | 'off'
  everyMinutes: number | null
}

export interface SyncProgress {
  /** Short stage label, e.g. 'scanning', 'fetching', 'pulling', 'indexing'. */
  stage: string
  /** Completed units in this stage, or null when indeterminate. */
  done: number | null
  /** Total units in this stage, or null when indeterminate. */
  total: number | null
  /** Optional current item label (e.g. repo name); never file paths or secrets. */
  item?: string | null
}

export interface SourceStatus {
  id: SourceId
  kind: 'obsidian' | 'repo' | 'keep' | 'gdrive'
  state: SourceState
  /** Short reason for `error` (an error class or a count), else null. */
  reason: string | null
  lastSyncAt: Date | null
  schedule: Schedule
  documents: number
  chunks: number
  /** A scan or fetch started by Sync now or Re-sync, or a scheduled repo round (github), is running. */
  syncing: boolean
  /** Live progress while syncing, when available. */
  progress?: SyncProgress | null
}

export interface RepoStatus {
  name: string
  /** `off` when the repo's source is switched off (`sources.enabled = false`). */
  state: 'healthy' | 'error' | 'off'
  reason: string | null
  lastSyncAt: Date | null
  documents: number
  chunks: number
  syncing: boolean
}

export interface ServerStatus {
  /** Always true: a response means the server answered. */
  reachable: true
  checkedAt: Date
  gemini: { available: boolean }
  devices: { active: number }
  /** Documents per source kind (`work` is never counted). */
  documents: Record<SearchableKind, number>
  sources: SourceStatus[]
  /** Configured repos in config order. */
  repos: RepoStatus[]
  /** A Sync now run or a scheduled repo round (startup or every 30 minutes) is in progress. */
  syncing: boolean
  health: 'ok' | 'warning' | 'broken'
  /** The last 50 events, newest first. */
  activity: ActivityEvent[]
}

export interface StatusService {
  status(): Promise<ServerStatus>
  activity(): Promise<ActivityEvent[]>
}

export interface StatusServiceOptions {
  sources: Pick<StatusStore, 'listSources'>
  activity: ActivityLog
  /** Active signed-in devices (R15); absent means 0 (login off). */
  devices?: () => Promise<number>
  /** R16 key set and last call not failed on the key; absent means false. */
  gemini?: () => Promise<boolean>
  /** Null when the vault is off (no PYTHIA_VAULT_PATH, or its source switched off). */
  vault: { watching: boolean; progress?: () => SyncProgress | null } | null
  /** Null when repos are off (no PYTHIA_REPOS_CONFIG). */
  repos: { names: readonly string[]; intervalMs: number; configError: string | null } | null
  /** Sync now state (syncNow.ts); absent means nothing is running. */
  syncing?: () => { running: boolean; repos: readonly string[] }
  /**
   * The repo scheduler's own state (T52): a round is running (the startup
   * round, the 30-minute round or one started by Sync now) and the repo being
   * fetched right now. Absent means repos are off.
   */
  repoRound?: () => { running: boolean; repo: string | null; progress?: SyncProgress | null }
  /** Null or absent when Drive is off (no PYTHIA_DRIVE_REMOTE, or its source switched off). */
  drive?: { intervalMs: number } | null
  /** The Drive scheduler's state: a round (startup, every 30 minutes or Sync now) is running. */
  driveRound?: () => { running: boolean; progress?: SyncProgress | null }
  now?: () => number
  /** Error classes only. */
  log?: (message: string) => void
}

const later = (a: Date | null, b: Date | null): Date | null => (a === null ? b : b === null || a >= b ? a : b)

export function createStatusService(options: StatusServiceOptions): StatusService {
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string) => console.error(message))

  /** A failing lookup degrades its field rather than failing the whole status. */
  async function safely<T>(what: string, task: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
    if (task === undefined) return fallback
    try {
      return await task()
    } catch (error) {
      log(`status: ${what} unavailable: ${error instanceof Error ? error.name : 'unknown'}`)
      return fallback
    }
  }

  const lastSync = (derived: DerivedState, source: string): Date | null =>
    later(derived.lastSyncAt, options.activity.lastSynced(source))

  return {
    activity: () => options.activity.list(),

    async status() {
      const [rows, events, devices, gemini] = await Promise.all([
        options.sources.listSources(),
        options.activity.list(),
        safely('devices', options.devices, 0),
        safely('gemini', options.gemini, false),
      ])
      const syncing = options.syncing?.() ?? { running: false, repos: [] }
      const round = (options.repos === null ? undefined : options.repoRound?.()) ?? { running: false, repo: null }
      const names = options.repos?.names ?? []
      const derived = deriveSourceStates(events, names)

      const documents = Object.fromEntries(SEARCHABLE_KINDS.map((kind) => [kind, 0])) as Record<SearchableKind, number>
      for (const row of rows) documents[row.kind] += row.documents
      const vaultRow = rows.find((row) => row.kind === 'obsidian')
      const keepRow = rows.find((row) => row.kind === 'keep')
      const driveRow = rows.find((row) => row.kind === 'gdrive')
      const repoRows = new Map(rows.filter((row) => row.kind === 'repo').map((row) => [row.name, row]))

      const vaultProgress = syncing.running ? (options.vault?.progress?.() ?? null) : null
      const vault: SourceStatus =
        options.vault === null
          ? {
              id: VAULT_SOURCE,
              kind: 'obsidian',
              state: 'off',
              reason: null,
              lastSyncAt: null,
              schedule: { kind: 'off', everyMinutes: null },
              documents: vaultRow?.documents ?? 0,
              chunks: vaultRow?.chunks ?? 0,
              syncing: false,
            }
          : {
              id: VAULT_SOURCE,
              kind: 'obsidian',
              state: derived.vault.state,
              reason: derived.vault.reason,
              lastSyncAt: lastSync(derived.vault, VAULT_SOURCE),
              schedule: { kind: options.vault.watching ? 'watch' : 'manual', everyMinutes: null },
              documents: vaultRow?.documents ?? 0,
              chunks: vaultRow?.chunks ?? 0,
              syncing: syncing.running,
              ...(vaultProgress === null ? {} : { progress: vaultProgress }),
            }

      const repos: RepoStatus[] = names.map((name) => {
        const row = repoRows.get(name)
        const state = derived.repo.get(name)
        const off = row !== undefined && !row.enabled
        return {
          name,
          state: off ? 'off' : (state?.state ?? 'healthy'),
          reason: off ? null : (state?.reason ?? null),
          lastSyncAt: later(state?.lastSyncAt ?? null, options.activity.lastSynced(name)),
          documents: row?.documents ?? 0,
          chunks: row?.chunks ?? 0,
          syncing: syncing.running || syncing.repos.includes(name) || round.repo === name,
        }
      })

      const failing = repos.filter((repo) => repo.state === 'error').length
      const repoTotals = [...repoRows.values()].reduce(
        (sum, row) => ({ documents: sum.documents + row.documents, chunks: sum.chunks + row.chunks }),
        { documents: 0, chunks: 0 },
      )
      const githubSyncing = options.repos !== null && (syncing.running || syncing.repos.length > 0 || round.running)
      const githubProgress = githubSyncing ? (round.progress ?? null) : null
      const github: SourceStatus = {
        id: REPOS_SOURCE,
        kind: 'repo',
        ...(options.repos === null
          ? { state: 'off', reason: null, lastSyncAt: null, schedule: { kind: 'off', everyMinutes: null } }
          : {
              state: options.repos.configError !== null || failing > 0 ? 'error' : 'healthy',
              reason:
                options.repos.configError ??
                (failing === 0 ? null : failing === 1 ? '1 repo failed' : `${failing} repos failed`),
              lastSyncAt: lastSync(derived.repos, REPOS_SOURCE),
              schedule: { kind: 'interval', everyMinutes: Math.round(options.repos.intervalMs / 60_000) },
            }),
        ...repoTotals,
        syncing: githubSyncing,
        ...(githubProgress === null ? {} : { progress: githubProgress }),
      }

      // Keep has no sync to fail on its own: it changes only when a Takeout zip is uploaded (R12).
      const keepOff = keepRow !== undefined && !keepRow.enabled
      const keep: SourceStatus = {
        id: KEEP_SOURCE,
        kind: 'keep',
        state: keepOff ? 'off' : 'manual',
        reason: null,
        lastSyncAt: lastSync(derived.keep, KEEP_SOURCE),
        schedule: { kind: keepOff ? 'off' : 'manual', everyMinutes: null },
        documents: keepRow?.documents ?? 0,
        chunks: keepRow?.chunks ?? 0,
        syncing: false,
      }

      // Drive (R19, T61): pulled and indexed every `everyMinutes`, at startup and on Sync now.
      const driveOptions = options.drive ?? null
      const driveState = driveOptions === null ? null : (options.driveRound?.() ?? { running: false })
      const driveRunning = driveState?.running ?? false
      const driveSyncing = driveOptions !== null && (syncing.running || driveRunning)
      const driveProgress = driveSyncing ? (driveState?.progress ?? null) : null
      const drive: SourceStatus =
        driveOptions === null
          ? {
              id: DRIVE_SOURCE,
              kind: 'gdrive',
              state: 'off',
              reason: null,
              lastSyncAt: null,
              schedule: { kind: 'off', everyMinutes: null },
              documents: driveRow?.documents ?? 0,
              chunks: driveRow?.chunks ?? 0,
              syncing: false,
            }
          : {
              id: DRIVE_SOURCE,
              kind: 'gdrive',
              state: derived.drive.state,
              reason: derived.drive.reason,
              lastSyncAt: lastSync(derived.drive, DRIVE_SOURCE),
              schedule: { kind: 'interval', everyMinutes: Math.round(driveOptions.intervalMs / 60_000) },
              documents: driveRow?.documents ?? 0,
              chunks: driveRow?.chunks ?? 0,
              syncing: driveSyncing,
              ...(driveProgress === null ? {} : { progress: driveProgress }),
            }

      return {
        reachable: true,
        checkedAt: new Date(now()),
        gemini: { available: gemini },
        devices: { active: devices },
        documents,
        sources: [vault, github, keep, drive],
        repos,
        syncing: syncing.running || round.running || driveRunning,
        health: 'ok',
        activity: events,
      }
    },
  }
}

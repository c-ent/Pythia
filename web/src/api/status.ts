import { offlineDb } from '../offline/db'
import { syncOnce } from '../offline/sync'
import { readPinnedRepos } from '../repos/pins'
import { ApiError, apiFetch } from './client'

// Mirrors `GET /api/status`, `GET /api/activity` and `POST /api/sync-now`
// (server/src/routes/status.ts, R18). Dates arrive as ISO strings.

export type StatusSourceId = 'obsidian' | 'github' | 'keep'
export type StatusSourceKind = 'obsidian' | 'repo' | 'keep'
export type SourceState = 'healthy' | 'error' | 'manual' | 'off'
export type RepoState = 'healthy' | 'error' | 'off'

/**
 * - `watch`: the vault watcher indexes changes as they arrive.
 * - `interval`: fetched every `everyMinutes` (repos).
 * - `manual`: only on demand (Keep upload, or a vault without the watcher).
 * - `off`: not configured.
 */
export type ScheduleKind = 'watch' | 'interval' | 'manual' | 'off'

export interface Schedule {
  kind: ScheduleKind
  everyMinutes: number | null
}

export interface SourceHealth {
  id: StatusSourceId
  kind: StatusSourceKind
  state: SourceState
  /** Short reason for `error` (an error class or a count), else null. */
  reason: string | null
  lastSyncAt: string | null
  schedule: Schedule
  documents: number
  chunks: number
  /** A scan or fetch started by Sync now or Re-sync is running. */
  syncing: boolean
}

export interface RepoHealth {
  name: string
  state: RepoState
  reason: string | null
  lastSyncAt: string | null
  documents: number
  chunks: number
  syncing: boolean
}

export const ACTIVITY_KINDS = [
  'vault_synced',
  'repos_fetched',
  'repo_fetched',
  'secrets_blocked',
  'keep_imported',
  'sync_error',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** Counts and short reasons only; `secrets_blocked` carries a count and nothing else. */
export interface ActivityEvent {
  id: number
  at: string
  kind: ActivityKind
  source: string | null
  count: number | null
  message: string | null
}

export interface DocumentCounts {
  obsidian: number
  keep: number
  repo: number
  chat: number
}

export interface ServerStatus {
  reachable: boolean
  checkedAt: string
  gemini: { available: boolean }
  devices: { active: number }
  documents: DocumentCounts
  /** A Sync now (or Re-sync) run is in progress. Startup, watcher and scheduled runs do not set it. */
  syncing: boolean
  /** Always obsidian, github, keep, in that order. */
  sources: SourceHealth[]
  /** Configured repos in config order. */
  repos: RepoHealth[]
  /** The last 50 events, newest first. */
  activity: ActivityEvent[]
}

export type SyncRunState = 'started' | 'running' | 'off'

export interface SyncNowResult {
  /** False when a run was already in progress (or nothing is configured). */
  started: boolean
  vault: SyncRunState
  repos: SyncRunState
}

const badResponse = (): ApiError => new ApiError(500, 'bad_response', 'Unexpected response')

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const countOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json()
    if (isObject(body)) return body
  } catch {
    // Not JSON; refused below.
  }
  throw badResponse()
}

const SOURCE_IDS: readonly StatusSourceId[] = ['obsidian', 'github', 'keep']
const SOURCE_KINDS: readonly StatusSourceKind[] = ['obsidian', 'repo', 'keep']
const SOURCE_STATES: readonly SourceState[] = ['healthy', 'error', 'manual', 'off']
const REPO_STATES: readonly RepoState[] = ['healthy', 'error', 'off']
const SCHEDULE_KINDS: readonly ScheduleKind[] = ['watch', 'interval', 'manual', 'off']
const RUN_STATES: readonly SyncRunState[] = ['started', 'running', 'off']

function parseSchedule(value: unknown): Schedule {
  if (!isObject(value)) return { kind: 'off', everyMinutes: null }
  return { kind: oneOf(value.kind, SCHEDULE_KINDS) ?? 'off', everyMinutes: countOrNull(value.everyMinutes) }
}

function parseSource(value: unknown): SourceHealth | null {
  if (!isObject(value)) return null
  const id = oneOf(value.id, SOURCE_IDS)
  const kind = oneOf(value.kind, SOURCE_KINDS)
  if (id === null || kind === null) return null
  return {
    id,
    kind,
    state: oneOf(value.state, SOURCE_STATES) ?? 'off',
    reason: text(value.reason),
    lastSyncAt: text(value.lastSyncAt),
    schedule: parseSchedule(value.schedule),
    documents: count(value.documents),
    chunks: count(value.chunks),
    syncing: value.syncing === true,
  }
}

function parseRepo(value: unknown): RepoHealth | null {
  if (!isObject(value) || typeof value.name !== 'string') return null
  return {
    name: value.name,
    state: oneOf(value.state, REPO_STATES) ?? 'off',
    reason: text(value.reason),
    lastSyncAt: text(value.lastSyncAt),
    documents: count(value.documents),
    chunks: count(value.chunks),
    syncing: value.syncing === true,
  }
}

function parseEvent(value: unknown): ActivityEvent | null {
  if (!isObject(value) || typeof value.id !== 'number' || typeof value.at !== 'string') return null
  const kind = oneOf(value.kind, ACTIVITY_KINDS)
  if (kind === null) return null
  return {
    id: value.id,
    at: value.at,
    kind,
    source: text(value.source),
    count: countOrNull(value.count),
    message: text(value.message),
  }
}

const present = <T>(value: T | null): value is T => value !== null

function parseActivity(value: unknown): ActivityEvent[] {
  if (!Array.isArray(value)) throw badResponse()
  return value.map(parseEvent).filter(present)
}

export function parseServerStatus(body: Record<string, unknown>): ServerStatus {
  if (typeof body.checkedAt !== 'string' || typeof body.syncing !== 'boolean' || !Array.isArray(body.sources)) {
    throw badResponse()
  }
  const documents = isObject(body.documents) ? body.documents : {}
  return {
    reachable: body.reachable !== false,
    checkedAt: body.checkedAt,
    gemini: { available: isObject(body.gemini) && body.gemini.available === true },
    devices: { active: isObject(body.devices) ? count(body.devices.active) : 0 },
    documents: {
      obsidian: count(documents.obsidian),
      keep: count(documents.keep),
      repo: count(documents.repo),
      chat: count(documents.chat),
    },
    syncing: body.syncing,
    sources: body.sources.map(parseSource).filter(present),
    repos: Array.isArray(body.repos) ? body.repos.map(parseRepo).filter(present) : [],
    activity: body.activity === undefined ? [] : parseActivity(body.activity),
  }
}

export async function getStatus(signal?: AbortSignal): Promise<ServerStatus> {
  return parseServerStatus(await readJson(await apiFetch('/api/status', { signal })))
}

export async function getActivity(signal?: AbortSignal): Promise<ActivityEvent[]> {
  return parseActivity((await readJson(await apiFetch('/api/activity', { signal }))).activity)
}

/** Asks the server to scan the vault and fetch every repo now; answered at once (202). */
export async function requestSyncNow(signal?: AbortSignal): Promise<SyncNowResult> {
  const body = await readJson(await apiFetch('/api/sync-now', { method: 'POST', signal }))
  if (typeof body.started !== 'boolean') throw badResponse()
  return {
    started: body.started,
    vault: oneOf(body.vault, RUN_STATES) ?? 'off',
    repos: oneOf(body.repos, RUN_STATES) ?? 'off',
  }
}

/** Window event fired when the server's sources or activity changed (Keep import, Sync now, Re-sync), so status views reload. */
export const STATUS_CHANGED = 'pythia:status'

export function statusChanged(): void {
  window.dispatchEvent(new Event(STATUS_CHANGED))
}

/** How often the status is polled while the server syncs. */
export const SYNC_POLL_MS = 2000
/** Longest wait for the server, in polls (15 minutes); after that this device is updated with what is ready. */
export const SYNC_MAX_POLLS = 450

/** Pulls this device's offline copy (notes plus pinned repos). Without IndexedDB there is nothing to update. */
export async function pullDeviceCopy(signal?: AbortSignal): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  await syncOnce(offlineDb(), { pinnedRepos: readPinnedRepos(), signal })
}

export type SyncNowPhase = 'server' | 'device'

export interface RunSyncNowOptions {
  signal?: AbortSignal
  /** Every status read while waiting for the server. */
  onStatus?: (status: ServerStatus) => void
  /** `server` before the request, `device` before this device's copy is pulled. */
  onPhase?: (phase: SyncNowPhase) => void
  /** Defaults to `pullDeviceCopy`. */
  pullDevice?: (signal?: AbortSignal) => Promise<unknown>
  pollMs?: number
  maxPolls?: number
}

export interface RunSyncNowResult {
  request: SyncNowResult
  /** The last status read. */
  status: ServerStatus
  /** False when the server was still syncing after the longest wait. */
  serverFinished: boolean
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/**
 * Sync now (R18): asks the server to scan and fetch, polls `GET /api/status`
 * until its run is over (also when another press already started it), then
 * pulls this device's offline copy. Fires `STATUS_CHANGED` when done. Used by
 * the sidebar card and Sources "Sync all"; Pinned "Update all now" (T45) can
 * call it too.
 */
export async function runSyncNow(options: RunSyncNowOptions = {}): Promise<RunSyncNowResult> {
  const { signal } = options
  const pollMs = options.pollMs ?? SYNC_POLL_MS
  const maxPolls = options.maxPolls ?? SYNC_MAX_POLLS
  options.onPhase?.('server')
  const request = await requestSyncNow(signal)
  // Status views reload now, so they show the run while it lasts.
  statusChanged()
  let status = await getStatus(signal)
  options.onStatus?.(status)
  for (let polls = 0; status.syncing && polls < maxPolls; polls++) {
    await delay(pollMs, signal)
    status = await getStatus(signal)
    options.onStatus?.(status)
  }
  options.onPhase?.('device')
  await (options.pullDevice ?? pullDeviceCopy)(signal)
  statusChanged()
  return { request, status, serverFinished: !status.syncing }
}

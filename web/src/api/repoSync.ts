import { apiFetch } from './client'

// Per-repo re-sync and per-repo status (R18, T42), for the Repos page (T44).
// `getRepoStatuses` reads only the `repos` part of `GET /api/status`; the
// shared status client for the rest of that answer lives with T43
// (`api/status.ts`), so the two can be merged later.

export type RepoHealth = 'healthy' | 'error' | 'off'

/** One entry of `repos` in `GET /api/status`, in config order. Dates are ISO strings. */
export interface RepoStatus {
  name: string
  state: RepoHealth
  /** Short reason for `error` (an error class), else null. */
  reason: string | null
  lastSyncAt: string | null
  documents: number
  chunks: number
  /** True only while a run started by Re-sync or Sync now is going. */
  syncing: boolean
}

/** Answer of `POST /api/repos/:name/sync` (202). `running` means a run was already going. */
export interface RepoSyncStart {
  name: string
  started: boolean
  state: 'started' | 'running'
}

const HEALTH: readonly RepoHealth[] = ['healthy', 'error', 'off']

function toRepoStatus(value: unknown): RepoStatus | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.name !== 'string') return null
  return {
    name: row.name,
    state: HEALTH.includes(row.state as RepoHealth) ? (row.state as RepoHealth) : 'healthy',
    reason: typeof row.reason === 'string' ? row.reason : null,
    lastSyncAt: typeof row.lastSyncAt === 'string' ? row.lastSyncAt : null,
    documents: typeof row.documents === 'number' ? row.documents : 0,
    chunks: typeof row.chunks === 'number' ? row.chunks : 0,
    syncing: row.syncing === true,
  }
}

/** The per-repo part of `GET /api/status`. */
export async function getRepoStatuses(signal?: AbortSignal): Promise<RepoStatus[]> {
  const res = await apiFetch('/api/status', { signal })
  const body: unknown = await res.json()
  const repos = body !== null && typeof body === 'object' ? (body as { repos?: unknown }).repos : undefined
  if (!Array.isArray(repos)) return []
  return repos.map(toRepoStatus).filter((row): row is RepoStatus => row !== null)
}

/**
 * Starts a fetch and re-index of one repo in the background. Throws `ApiError`
 * 404 `not_found` (not in the server's config) or 409 `repos_off`.
 */
export async function startRepoSync(name: string): Promise<RepoSyncStart> {
  const res = await apiFetch(`/api/repos/${encodeURIComponent(name)}/sync`, { method: 'POST' })
  const body = (await res.json()) as Partial<RepoSyncStart>
  return {
    name: typeof body.name === 'string' ? body.name : name,
    started: body.started === true,
    state: body.state === 'running' ? 'running' : 'started',
  }
}

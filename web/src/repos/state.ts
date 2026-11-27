import type { RepoOverview } from '../api/repos'

// Shared state shapes for the Repos page (T44): ReposScreen owns the data,
// RepoDetail draws it.

export type OverviewEntry =
  | { status: 'loading' }
  | { status: 'done'; overview: RepoOverview }
  | { status: 'error'; message: string }

/** A Re-sync started from this page: asked for, running on the server, finished or failed. */
export type SyncEntry = { phase: 'starting' } | { phase: 'running' } | { phase: 'done' } | { phase: 'failed'; message: string }

export type AllowAskState =
  | { state: 'loading' }
  /** The rules could not be read; `allowed` is what the repo's overview says, when known. */
  | { state: 'error'; message: string; allowed: boolean | null }
  | { state: 'ready'; allowed: boolean; saving: boolean; error: string | null }

export const isSyncBusy = (sync: SyncEntry | undefined): boolean => sync?.phase === 'starting' || sync?.phase === 'running'

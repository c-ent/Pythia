import { ApiError } from '../api/client'

export const REPOS_OFFLINE_MESSAGE = 'You’re offline. The repo list needs a connection.'

/** From this width the Repos page shows the list and the detail panel side by side (Tablet and Desktop boards). */
export const REPOS_WIDE_QUERY = '(min-width: 48rem)'

/** How often the page asks `GET /api/status` whether a Re-sync it started is still running. */
export const SYNC_POLL_MS = 3000

export function repoListErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  // The server registers `/api/repos` only when repo indexing is configured.
  if (error instanceof ApiError && error.status === 404) return 'Repo indexing isn’t set up on the server yet.'
  return 'Couldn’t load repos. Try again.'
}

export function overviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (error instanceof ApiError && error.status === 404) return 'This repo is no longer indexed.'
  return 'Couldn’t load the overview. Try again.'
}

/** Re-sync (T44): `POST /api/repos/:name/sync` failed before a run started. */
export function resyncErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
    if (error.status === 409) return 'Repo fetching is off on this server, so it can’t re-sync.'
    if (error.status === 404) return 'This repo isn’t in the server’s repo list anymore, so it can’t re-sync.'
  }
  return 'Couldn’t start the sync. Try again.'
}

/** A run the page started ended in `error` (`reason` is an error class from `GET /api/status`). */
export function syncFailedMessage(reason: string | null): string {
  return reason === null || reason === '' ? 'The sync failed. The previous index is kept.' : `The sync failed (${reason}). The previous index is kept.`
}

export const SYNC_CHECK_FAILED_MESSAGE = 'Couldn’t check on the sync. Reload the page to see the result.'

export function rulesLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server, so this switch is unavailable.'
  if (error instanceof ApiError && error.status === 404) return 'Gemini rules aren’t available on this server.'
  return 'Couldn’t load the Gemini rules, so this switch is unavailable.'
}

export function rulesSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. The switch is unchanged.'
    if (error.status === 400) return error.message
  }
  return 'Couldn’t save the change. Try again.'
}

/** What the repo indexer leaves out (server/src/ingest/repoFilter.ts, R9). */
export const SKIPPED_TEXT =
  'Skipped: .gitignore matches, node_modules, vendor, dist and build folders, lockfiles, minified files, .env and key files, binaries, images and data files, and files over 200 KB.'

export const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

/** Date and time in the profile's time zone, e.g. "27 Nov 2026, 07:42". */
export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date)
  } catch {
    // Unknown time zone name: the device's.
    return new Intl.DateTimeFormat(undefined, options).format(date)
  }
}

export function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

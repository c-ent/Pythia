import { ApiError } from '../api/client'
import type { ActivityEvent, Schedule, SourceHealth, StatusSourceId } from '../api/status'
import { formatBytes, type CacheCounts } from '../offline/storage'
import { plural } from '../repos/format'

// Text for Sources and sync, the sidebar "Offline ready" card and the top bar (R18).

export type Tone = 'success' | 'danger' | 'warning' | 'muted'

/** "7:42 AM" today, "Nov 2" this year, "Nov 2, 2025" before. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Whole days between `iso` and `now`, never negative. */
export function daysSince(iso: string, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(iso).getTime()
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 86_400_000))
}

const SOURCE_TITLES: Record<StatusSourceId, string> = {
  obsidian: 'Obsidian vault',
  github: 'GitHub repos',
  keep: 'Google Keep',
}

export const sourceTitle = (id: StatusSourceId): string => SOURCE_TITLES[id]

/** Why `GET /api/status` failed, for the Sources and sync page. */
export function statusErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  if (error instanceof ApiError && error.status === 404) return 'Sources and sync isn’t available on this server yet.'
  return 'Couldn’t load the sources. Try again.'
}

/** An event's source as people read it: the three sources by title, a repo by its name. */
export function eventSourceName(source: string | null): string | null {
  if (source === null) return null
  return source in SOURCE_TITLES ? SOURCE_TITLES[source as StatusSourceId] : source
}

/** "every 15 min", "every hour", "daily", "watching for changes", "on demand"; null when off. */
export function scheduleLabel(schedule: Schedule): string | null {
  switch (schedule.kind) {
    case 'watch':
      return 'watching for changes'
    case 'manual':
      return 'on demand'
    case 'off':
      return null
    case 'interval': {
      const minutes = schedule.everyMinutes
      if (minutes === null || minutes <= 0) return 'on a schedule'
      if (minutes === 1440) return 'daily'
      if (minutes === 60) return 'every hour'
      if (minutes % 60 === 0) return `every ${minutes / 60} hours`
      return `every ${minutes} min`
    }
  }
}

/** The line under a source's title. */
export function sourceDetail(source: SourceHealth, repoCount: number, now: Date = new Date()): string {
  if (source.state === 'off') return 'Not configured on the server.'
  const schedule = scheduleLabel(source.schedule)
  const parts: (string | null)[] =
    source.id === 'obsidian'
      ? [plural(source.documents, 'note'), plural(source.chunks, 'chunk'), schedule]
      : source.id === 'github'
        ? [plural(repoCount, 'repo'), plural(source.documents, 'file'), schedule]
        : [
            'Takeout import',
            plural(source.documents, 'note'),
            source.lastSyncAt === null ? 'not imported yet' : `imported ${formatWhen(source.lastSyncAt, now)}`,
          ]
  return parts.filter((part) => part !== null).join(' · ')
}

/** The health pill: "Healthy · 7:42 AM", "Error · fetch failed", "Manual · 23 days old", "Off". */
export function sourceState(source: SourceHealth, now: Date = new Date()): { label: string; tone: Tone } {
  if (source.syncing) return { label: 'Syncing…', tone: 'muted' }
  switch (source.state) {
    case 'healthy':
      return {
        label: source.lastSyncAt === null ? 'Healthy' : `Healthy · ${formatWhen(source.lastSyncAt, now)}`,
        tone: 'success',
      }
    case 'error':
      return { label: `Error · ${source.reason ?? 'sync failed'}`, tone: 'danger' }
    case 'manual': {
      if (source.lastSyncAt === null) return { label: 'Manual · not imported yet', tone: 'muted' }
      const days = daysSince(source.lastSyncAt, now)
      return { label: `Manual · ${days === 0 ? 'today' : `${plural(days, 'day')} old`}`, tone: 'muted' }
    }
    case 'off':
      return { label: 'Off', tone: 'muted' }
  }
}

/**
 * One activity row. Only counts, source names and the server's short reason
 * are shown; a `secrets_blocked` event shows its count and nothing else from
 * the server.
 */
export function activityText(event: ActivityEvent): { title: string; detail: string; tone: Tone } {
  const source = eventSourceName(event.source)
  const join = (...parts: (string | null)[]): string => parts.filter((part) => part !== null && part !== '').join(' · ')
  const n = event.count
  switch (event.kind) {
    case 'vault_synced':
      return {
        title: 'Vault synced',
        detail: join(n === null ? null : `${plural(n, 'note')} changed`, event.message),
        tone: 'success',
      }
    case 'repos_fetched':
      return {
        title: 'Repos fetched',
        detail: join(n === null ? null : `${plural(n, 'repo')} synced`, event.message),
        tone: 'success',
      }
    case 'repo_fetched':
      return { title: 'Repo fetched', detail: join(source), tone: 'success' }
    case 'keep_imported':
      return {
        title: 'Google Keep imported',
        detail: join(n === null ? null : plural(n, 'note'), event.message),
        tone: 'success',
      }
    case 'secrets_blocked': {
      const blocked = n ?? 0
      return {
        title: blocked === 1 ? 'Skipped a secret' : 'Skipped secrets',
        detail: join(`${plural(blocked, 'chunk')} blocked`, source === null ? null : `in ${source}`),
        tone: 'warning',
      }
    }
    case 'sync_error':
      return { title: 'Sync failed', detail: join(source, event.message), tone: 'danger' }
  }
}

/**
 * The sidebar card's line: "48 notes, 6 repos cached · 6.4 MB. Synced 7:42 AM."
 * `repos` is the number of pinned repos (their files are cached).
 */
export function offlineSummary(
  counts: CacheCounts,
  repos: number,
  usage: number | null,
  now: Date = new Date(),
): string {
  const size = usage === null || usage <= 0 ? '' : ` · ${formatBytes(usage)}`
  const cached = `${plural(counts.notes, 'note')}, ${plural(repos, 'repo')} cached${size}.`
  const synced = counts.syncedAt === null ? 'Not synced on this device yet.' : `Synced ${formatWhen(counts.syncedAt, now)}.`
  return `${cached} ${synced}`
}

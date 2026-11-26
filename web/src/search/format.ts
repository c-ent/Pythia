import { FolderGit2, NotebookPen, StickyNote, type LucideIcon } from 'lucide-react'
import { ApiError } from '../api/client'
import type { SearchResult, SourceKind, SourceRef } from '../api/search'

export const SEARCH_LIMIT = 20

/** Source chip labels (the mock-ups' All, Notes, Repos, Keep). */
export const SOURCE_LABELS: Record<SourceKind, string> = { obsidian: 'Notes', repo: 'Repos', keep: 'Keep' }
export const SOURCE_ICONS: Record<SourceKind, LucideIcon> = { obsidian: NotebookPen, repo: FolderGit2, keep: StickyNote }

/** Badge text: the repo's name for repos, the source kind otherwise. */
export function sourceLabel(source: SourceRef): string {
  if (source.kind === 'repo') return source.name
  return source.kind === 'obsidian' ? 'Obsidian' : 'Keep'
}

/** The heading path without the note title in front, joined with `›`, or null when it adds nothing. */
export function headingTrail(result: Pick<SearchResult, 'title' | 'headingPath'>): string | null {
  let path = result.headingPath.trim()
  if (path === '' || path === result.title) return null
  const prefix = `${result.title} > `
  if (path.startsWith(prefix)) path = path.slice(prefix.length)
  return path.split(' > ').join(' › ')
}

/**
 * "just now", "5 min ago", "2h ago", "3d ago", then a date ("12 Oct", with the
 * year when it is not this year) in `timeZone`. Empty for an unreadable time.
 */
export function timeAgo(iso: string, now: number = Date.now(), timeZone?: string): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const sameYear = new Date(then).getUTCFullYear() === new Date(now).getUTCFullYear()
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(then)
  } catch {
    // Unknown time zone name: fall back to the device's.
    return new Intl.DateTimeFormat('en-GB', options).format(then)
  }
}

export function resultCount(n: number): string {
  return n === 1 ? '1 result' : `${n} results`
}

export const OFFLINE_MESSAGE = 'You’re offline. Search needs a connection.'

export function searchErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
    if (error.status === 400) return 'That search couldn’t be run. Check the text and try again.'
  }
  return 'Search failed. Try again.'
}

/** `withMatches`: the search results show under the answer (Search in Ask mode), so they still help. */
export function askErrorMessage(error: unknown, withMatches = true): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server, so there’s no answer. Check your connection and try again.'
    if (error.status === 400) return 'That question couldn’t be asked. Check the text and try again.'
  }
  return withMatches ? 'The answer failed. The matches below still work; try asking again.' : 'The answer failed. Try asking again.'
}

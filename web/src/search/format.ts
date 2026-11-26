import { FolderGit2, NotebookPen, StickyNote, type LucideIcon } from 'lucide-react'
import { ApiError } from '../api/client'
import type { SearchResult, SourceKind, SourceRef } from '../api/search'

export const SEARCH_LIMIT = 20

export const SOURCE_LABELS: Record<SourceKind, string> = { obsidian: 'Obsidian', repo: 'Repos', keep: 'Keep' }
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

export function askErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server, so there’s no answer. Check your connection and try again.'
    if (error.status === 400) return 'That question couldn’t be asked. Check the text and try again.'
  }
  return 'The answer failed. The matches below still work; try asking again.'
}

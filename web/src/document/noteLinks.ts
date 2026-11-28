import type { Backlink, OutgoingLink } from '../api/backlinks'
import type { SourceKind } from '../api/search'

/** What the small line under a backlink says: the alias, the heading and the link count. */
export function backlinkDetails(link: Pick<Backlink, 'count' | 'display' | 'heading'>): string | null {
  const parts: string[] = []
  if (link.display !== null && link.display !== '') parts.push(`as “${link.display}”`)
  if (link.heading !== null && link.heading !== '') parts.push(`to “${link.heading}”`)
  if (link.count > 1) parts.push(`${link.count} links`)
  return parts.length === 0 ? null : parts.join(' · ')
}

/** Sources whose documents have note links and backlinks (R20): repos and Drive have none. */
export function hasNoteLinks(kind: SourceKind): boolean {
  return kind === 'obsidian' || kind === 'keep'
}

/**
 * The note a link points at, as compared between the viewer and the server's
 * outgoing links: heading dropped, decoded, NFC, trimmed, `/` separators, no
 * `.md`, lower case (the server's `nameKey`, applied to the link as written).
 */
export function noteLinkKey(target: string): string {
  const hash = target.indexOf('#')
  const page = hash === -1 ? target : target.slice(0, hash)
  let decoded = page
  try {
    decoded = decodeURIComponent(page)
  } catch {
    // A literal `%` in a note name: keep it as written.
  }
  return decoded.normalize('NFC').trim().replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase()
}

/**
 * Link key to document id, or null for a ghost (a target no note matches).
 * A key the server did not list is absent, so the viewer leaves it as it was.
 */
export function linkTargets(links: readonly OutgoingLink[]): Map<string, number | null> {
  const targets = new Map<string, number | null>()
  for (const link of links) {
    const key = noteLinkKey(link.target)
    if (key === '') continue
    // The same key written twice resolves the same; a resolved one wins over a ghost.
    if (targets.get(key) == null) targets.set(key, link.documentId)
  }
  return targets
}

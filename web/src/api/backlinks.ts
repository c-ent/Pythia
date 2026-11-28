import { apiFetch } from './client'
import type { SourceRef } from './search'

// Mirrors `GET /api/documents/:id/backlinks` as planned for T68c (server/src/search/
// backlink service). T69 was built first against this shape; keep the two in step.

export interface BacklinkPassage {
  headingPath: string
  /** Plain text around the link, capped by the server; never HTML. */
  text: string
}

/** One note that links to the opened note (same source only). */
export interface Backlink {
  id: number
  source: SourceRef
  sourceLabel: string
  title: string
  allowLlm: boolean
  /** How many links that note has to this one. */
  count: number
  /** The alias of the first link (`[[Note|alias]]`), or null. */
  display: string | null
  /** The heading the first link points at (`[[Note#Heading]]`), or null. */
  heading: string | null
  passage: BacklinkPassage | null
}

/** A note link in the opened note, resolved by the server; `documentId: null` is a ghost. */
export interface OutgoingLink {
  /** As written in the note (a wikilink target, or a Markdown link path, decoded). */
  target: string
  heading: string | null
  display: string | null
  documentId: number | null
}

export interface BacklinksResponse {
  /** False for repo and Drive documents, which have no note links. */
  supported: boolean
  backlinks: Backlink[]
  outgoing: OutgoingLink[]
}

export async function getBacklinks(id: number, signal?: AbortSignal): Promise<BacklinksResponse> {
  const res = await apiFetch(`/api/documents/${id}/backlinks`, { signal })
  return (await res.json()) as BacklinksResponse
}

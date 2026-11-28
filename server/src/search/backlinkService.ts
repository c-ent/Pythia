import type { BacklinkStore, SourceNote, StoredChunk, StoredNoteLink } from '../db/linkStore.js'
import type { SearchableKind } from '../db/searchStore.js'
import { buildNoteIndex, noteKeys, noteLinksInText, resolveLink, type LinkWrite, type NoteIndex } from '../ingest/links.js'
import { capText, type SourceRef } from './searchService.js'

/**
 * Backlinks and outgoing note links (R20, T68c) of one Obsidian or Keep note,
 * read from `links` and resolved against the documents stored now (path,
 * then title, then alias; `resolveLink`), same source only. Shared by REST
 * and, later, `/mcp`. Repo and Drive documents have no note links.
 */

/** Longest passage text per backlink: the sentence or paragraph around the link, not the note. */
export const MAX_BACKLINK_PASSAGE_CHARS = 400
export const DEFAULT_BACKLINKS = 50
export const MAX_BACKLINKS = 200

const LINKED_KINDS: readonly SearchableKind[] = ['obsidian', 'keep']

export interface BacklinksRequest {
  documentId: number
  limit?: number
}

export interface BacklinkPassage {
  headingPath: string
  /** Plain text, at most `MAX_BACKLINK_PASSAGE_CHARS`. */
  text: string
}

export interface Backlink {
  id: number
  source: SourceRef
  sourceLabel: string
  title: string
  allowLlm: boolean
  /** How many links that note has to this one. */
  count: number
  /** The display text of the first link, or null. */
  display: string | null
  /** The heading the first link points at, or null. */
  heading: string | null
  passage: BacklinkPassage | null
}

export interface OutgoingLink {
  /** As stored in `links.target`: the wikilink target without heading, or the decoded Markdown link path. */
  target: string
  heading: string | null
  display: string | null
  /** The note it resolves to, or null for a ghost. */
  documentId: number | null
}

export interface BacklinksResponse {
  documentId: number
  /** False for repo and Drive documents, which have no note links. */
  supported: boolean
  backlinks: Backlink[]
  outgoing: OutgoingLink[]
}

export interface BacklinkService {
  /** Null when the document does not exist or is not visible. */
  backlinks(request: BacklinksRequest): Promise<BacklinksResponse | null>
}

export const sourceLabel = (kind: SearchableKind, name: string): string =>
  kind === 'obsidian' ? 'Obsidian' : kind === 'keep' ? 'Keep' : kind === 'gdrive' ? 'Drive' : name

type LinkFields = Pick<LinkWrite, 'kind' | 'target' | 'heading' | 'display'>

const sameLink = (a: LinkFields, b: LinkFields): boolean =>
  a.kind === b.kind && a.target === b.target && a.heading === b.heading && a.display === b.display

/**
 * The paragraph of the linking note that holds the link, from its stored
 * chunks; null when no stored paragraph holds it (the chunk text changed).
 */
export function linkPassage(chunks: readonly StoredChunk[], link: StoredNoteLink): BacklinkPassage | null {
  for (const chunk of chunks) {
    for (const paragraph of chunk.content.split(/\r?\n\s*\r?\n/)) {
      if (!noteLinksInText(paragraph).some((found) => sameLink(found, link))) continue
      return { headingPath: chunk.headingPath, text: capText(paragraph.trim(), MAX_BACKLINK_PASSAGE_CHARS).text }
    }
  }
  return null
}

const byTitleThenPath = (a: SourceNote, b: SourceNote): number => {
  const title = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  if (title !== 0) return title
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export function createBacklinkService(options: { store: BacklinkStore }): BacklinkService {
  const { store } = options
  return {
    async backlinks(request) {
      const limit = Math.min(MAX_BACKLINKS, Math.max(1, Math.trunc(request.limit ?? DEFAULT_BACKLINKS)))
      const doc = await store.document(request.documentId)
      if (doc === null) return null
      const empty: BacklinksResponse = { documentId: doc.id, supported: false, backlinks: [], outgoing: [] }
      if (!LINKED_KINDS.includes(doc.sourceKind)) return empty

      const [own, incoming, notes] = await Promise.all([
        store.noteLinks(doc.id),
        store.linksTo(doc.sourceId, noteKeys(doc)),
        store.notes(doc.sourceId),
      ])
      const index: NoteIndex<SourceNote> = buildNoteIndex(notes)
      const byId = new Map(notes.map((note) => [note.id, note]))

      const outgoing = own.map((link) => ({
        target: link.target,
        heading: link.heading,
        display: link.display,
        documentId: resolveLink(index, doc.path, link)?.id ?? null,
      }))

      // A candidate only counts when it resolves to this note: a same-name
      // note in another folder, or a closer match, takes the link instead.
      const groups = new Map<number, { note: SourceNote; links: StoredNoteLink[] }>()
      for (const link of incoming) {
        if (link.documentId === doc.id) continue
        const from = byId.get(link.documentId)
        if (from === undefined || resolveLink(index, from.path, link)?.id !== doc.id) continue
        const group = groups.get(from.id)
        if (group === undefined) groups.set(from.id, { note: from, links: [link] })
        else group.links.push(link)
      }
      const kept = [...groups.values()].sort((a, b) => byTitleThenPath(a.note, b.note)).slice(0, limit)

      const chunks = await store.chunks(kept.map((group) => group.note.id))
      const chunksOf = new Map<number, StoredChunk[]>()
      for (const chunk of chunks) {
        const list = chunksOf.get(chunk.documentId)
        if (list === undefined) chunksOf.set(chunk.documentId, [chunk])
        else list.push(chunk)
      }

      const source: SourceRef = { kind: doc.sourceKind, name: doc.sourceName }
      const backlinks = kept.map(({ note, links }): Backlink => {
        const first = links[0]!
        return {
          id: note.id,
          source,
          sourceLabel: sourceLabel(doc.sourceKind, doc.sourceName),
          title: note.title,
          allowLlm: note.allowLlm,
          count: links.length,
          display: first.display,
          heading: first.heading,
          passage: linkPassage(chunksOf.get(note.id) ?? [], first),
        }
      })
      return { ...empty, supported: true, backlinks, outgoing }
    },
  }
}

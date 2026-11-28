import type { Pool } from 'pg'
import { NOTE_LINK_KINDS, type NoteLinkKind } from '../ingest/links.js'
import type { SearchableKind } from './searchStore.js'

/**
 * Reads `links` (R20, T68c) for the backlink service. Targets are stored as
 * written; resolving them (`resolveLink`, ingest/links.ts) happens in the
 * service, against the documents stored now, so this store only reads rows.
 * Switched-off and `work` sources are never returned.
 */

/** The opened document, with its own aliases (the names other notes may link to it by). */
export interface LinkedDocument {
  id: number
  sourceId: number
  sourceKind: SearchableKind
  sourceName: string
  path: string
  title: string
  aliases: string[]
}

/** A document of the source a link can resolve to. */
export interface SourceNote {
  id: number
  path: string
  title: string
  allowLlm: boolean
  aliases: string[]
}

/** One wikilink, embed or Markdown note link row. */
export interface StoredNoteLink {
  documentId: number
  ordinal: number
  kind: NoteLinkKind
  target: string
  heading: string | null
  display: string | null
}

export interface StoredChunk {
  documentId: number
  ordinal: number
  headingPath: string
  content: string
}

/** What the backlink service needs from the database. Tests use an in-memory version. */
export interface BacklinkStore {
  /** Null when the document does not exist or is not visible (work, switched-off source). */
  document(documentId: number): Promise<LinkedDocument | null>
  /** The document's note links, in stored order. */
  noteLinks(documentId: number): Promise<StoredNoteLink[]>
  /** Note links in the source whose `target_key` is one of `keys`, by document then stored order. */
  linksTo(sourceId: number, keys: readonly string[]): Promise<StoredNoteLink[]>
  /** Every document of the source, with its aliases: what links resolve against. */
  notes(sourceId: number): Promise<SourceNote[]>
  /** The stored chunks of these documents, by document then ordinal. */
  chunks(documentIds: readonly number[]): Promise<StoredChunk[]>
}

interface LinkRow {
  document_id: string
  ordinal: number
  kind: NoteLinkKind
  target: string
  heading: string | null
  display: string | null
}

const toLink = (row: LinkRow): StoredNoteLink => ({
  documentId: Number(row.document_id),
  ordinal: row.ordinal,
  kind: row.kind,
  target: row.target,
  heading: row.heading,
  display: row.display,
})

const NOTE_KINDS = [...NOTE_LINK_KINDS]

export function createPgBacklinkStore(pool: Pool): BacklinkStore {
  return {
    async document(documentId) {
      const { rows } = await pool.query<{
        id: string
        source_id: string
        kind: SearchableKind
        name: string
        path: string
        title: string
        aliases: string[]
      }>(
        `SELECT d.id, d.source_id, s.kind, s.name, d.path, d.title,
                ARRAY(
                  SELECT l.target FROM links l
                  WHERE l.document_id = d.id AND l.kind = 'alias'
                  ORDER BY l.ordinal
                ) AS aliases
         FROM documents d
         JOIN sources s ON s.id = d.source_id
         WHERE d.id = $1 AND s.enabled AND s.kind <> 'work'`,
        [documentId],
      )
      const row = rows[0]
      if (row === undefined) return null
      return {
        id: Number(row.id),
        sourceId: Number(row.source_id),
        sourceKind: row.kind,
        sourceName: row.name,
        path: row.path,
        title: row.title,
        aliases: row.aliases,
      }
    },

    async noteLinks(documentId) {
      const { rows } = await pool.query<LinkRow>(
        `SELECT document_id, ordinal, kind, target, heading, display
         FROM links
         WHERE document_id = $1 AND kind = ANY ($2::text[])
         ORDER BY ordinal`,
        [documentId, NOTE_KINDS],
      )
      return rows.map(toLink)
    },

    async linksTo(sourceId, keys) {
      if (keys.length === 0) return []
      // links_target_key_idx (target_key, kind) finds the candidates; resolving
      // them to one note is the service's job.
      const { rows } = await pool.query<LinkRow>(
        `SELECT l.document_id, l.ordinal, l.kind, l.target, l.heading, l.display
         FROM links l
         JOIN documents d ON d.id = l.document_id
         WHERE l.target_key = ANY ($2::text[]) AND l.kind = ANY ($3::text[]) AND d.source_id = $1
         ORDER BY l.document_id, l.ordinal`,
        [sourceId, [...keys], NOTE_KINDS],
      )
      return rows.map(toLink)
    },

    async notes(sourceId) {
      const { rows } = await pool.query<{ id: string; path: string; title: string; allow_llm: boolean; aliases: string[] }>(
        `SELECT d.id, d.path, d.title, d.allow_llm,
                array_remove(array_agg(l.target ORDER BY l.ordinal), NULL) AS aliases
         FROM documents d
         LEFT JOIN links l ON l.document_id = d.id AND l.kind = 'alias'
         WHERE d.source_id = $1
         GROUP BY d.id
         ORDER BY d.id`,
        [sourceId],
      )
      return rows.map((row) => ({
        id: Number(row.id),
        path: row.path,
        title: row.title,
        allowLlm: row.allow_llm,
        aliases: row.aliases,
      }))
    },

    async chunks(documentIds) {
      if (documentIds.length === 0) return []
      const { rows } = await pool.query<{ document_id: string; ordinal: number; heading_path: string; content: string }>(
        `SELECT document_id, ordinal, heading_path, content
         FROM chunks
         WHERE document_id = ANY ($1::bigint[])
         ORDER BY document_id, ordinal`,
        [[...documentIds]],
      )
      return rows.map((row) => ({
        documentId: Number(row.document_id),
        ordinal: row.ordinal,
        headingPath: row.heading_path,
        content: row.content,
      }))
    },
  }
}

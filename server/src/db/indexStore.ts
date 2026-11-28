import type { Pool, PoolClient } from 'pg'
import type { LinkWrite } from '../ingest/links.js'
import { refreshDocumentVector } from './documentVectorStore.js'

/** Every kind except `work`, which default ingestion never creates (R2). */
export type IngestSourceKind = 'obsidian' | 'keep' | 'repo' | 'chat' | 'gdrive'

export interface SourceRow {
  id: number
  enabled: boolean
}

export interface DocumentState {
  contentHash: string
  allowLlm: boolean
  /** Some chunk was embedded with a different model (or none) and needs re-embedding. */
  stale: boolean
  /** Obsidian note tags as last stored (R16 tag rules); empty for other sources. Absent means none. */
  tags?: string[]
  /**
   * `linksKey` (ingest/links.ts) of the stored link rows (R20); `NO_LINKS_KEY`
   * when there are none. Absent when the store does not report it.
   */
  linksKey?: string
}

export interface DocumentWrite {
  path: string
  title: string
  language: string | null
  contentHash: string
  allowLlm: boolean
  mtime: Date | null
  /** Obsidian note tags, lower case, without `#`. Absent means none. */
  tags?: readonly string[]
  /** Explicit links, tags, labels and aliases of an Obsidian or Keep note (R20). Absent means none. */
  links?: readonly LinkWrite[]
}

export interface ChunkWrite {
  ordinal: number
  headingPath: string
  startLine: number | null
  endLine: number | null
  content: string
  embedding: readonly number[]
}

/** What the ingest pipelines need from the database. Tests use an in-memory version. */
export interface IndexStore {
  /** States of a source's documents, keyed by path; only `paths` when given. */
  getDocumentStates(sourceId: number, embedModel: string, paths?: readonly string[]): Promise<Map<string, DocumentState>>
  /**
   * Upserts the document and replaces all of its chunks in one transaction,
   * together with its map vector (`document_vectors`, R20) for map documents
   * and its link rows (`links`, R20).
   */
  replaceDocument(sourceId: number, doc: DocumentWrite, chunks: readonly ChunkWrite[], embedModel: string): Promise<void>
  /**
   * Replaces only the link rows of a stored document (R20), for a note whose
   * text is unchanged but whose links were never stored (before T68). Never
   * touches chunks; does nothing when the document is not stored.
   */
  replaceLinks(sourceId: number, path: string, links: readonly LinkWrite[]): Promise<void>
  /** Sets `allow_llm`, and the stored tags too when `tags` is given. Never touches chunks. */
  setAllowLlm(sourceId: number, path: string, allowLlm: boolean, tags?: readonly string[]): Promise<void>
  /** Deletes the documents (chunks cascade) and returns how many existed. */
  deleteDocuments(sourceId: number, paths: readonly string[]): Promise<number>
}

/** Postgres rejects NUL in text columns; a stray one must not fail the whole note. */
const stripNul = (text: string): string => text.replaceAll('\u0000', '')

const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`

/** Replaces the link rows of one document, inside the caller's transaction. */
async function writeLinks(client: PoolClient, documentId: string, links: readonly LinkWrite[]): Promise<void> {
  await client.query('DELETE FROM links WHERE document_id = $1', [documentId])
  if (links.length === 0) return
  await client.query(
    `INSERT INTO links (document_id, ordinal, kind, target, target_key, heading, display)
     SELECT $1, t.ordinal, t.kind, t.target, t.target_key, t.heading, t.display
     FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       AS t (ordinal, kind, target, target_key, heading, display)`,
    [
      documentId,
      links.map((_, i) => i),
      links.map((link) => link.kind),
      links.map((link) => stripNul(link.target)),
      links.map((link) => stripNul(link.targetKey)),
      links.map((link) => (link.heading === null ? null : stripNul(link.heading))),
      links.map((link) => (link.display === null ? null : stripNul(link.display))),
    ],
  )
}

/**
 * Finds the source by kind and name, creating it on first use and keeping
 * `root_path` current. `enabled` is the owner's switch; it is never changed here.
 */
export async function ensureSource(
  pool: Pool,
  kind: IngestSourceKind,
  name: string,
  rootPath: string,
): Promise<SourceRow> {
  const existing = await pool.query<{ id: string; enabled: boolean }>(
    'UPDATE sources SET root_path = $3 WHERE kind = $1 AND name = $2 RETURNING id, enabled',
    [kind, name, rootPath],
  )
  const row =
    existing.rows[0] ??
    (
      await pool.query<{ id: string; enabled: boolean }>(
        'INSERT INTO sources (kind, name, root_path) VALUES ($1, $2, $3) RETURNING id, enabled',
        [kind, name, rootPath],
      )
    ).rows[0]
  if (row === undefined) throw new Error('could not create source row')
  return { id: Number(row.id), enabled: row.enabled }
}

export function createPgIndexStore(pool: Pool): IndexStore {
  return {
    async getDocumentStates(sourceId, embedModel, paths) {
      const { rows } = await pool.query<{
        path: string
        content_hash: string
        allow_llm: boolean
        stale: boolean
        tags: string[]
        links: unknown[]
      }>(
        `SELECT d.path, d.content_hash, d.allow_llm, d.tags,
                EXISTS (
                  SELECT 1 FROM chunks c
                  WHERE c.document_id = d.id AND c.embed_model IS DISTINCT FROM $2
                ) AS stale,
                COALESCE((
                  SELECT json_agg(json_build_array(l.kind, l.target, l.heading, l.display) ORDER BY l.ordinal)
                  FROM links l WHERE l.document_id = d.id
                ), '[]'::json) AS links
         FROM documents d
         WHERE d.source_id = $1 AND ($3::text[] IS NULL OR d.path = ANY ($3::text[]))`,
        [sourceId, embedModel, paths === undefined ? null : [...paths]],
      )
      return new Map(
        rows.map((row) => [
          row.path,
          {
            contentHash: row.content_hash,
            allowLlm: row.allow_llm,
            stale: row.stale,
            tags: row.tags,
            // Same form as linksKey() in ingest/links.ts.
            linksKey: JSON.stringify(row.links),
          },
        ]),
      )
    },

    async replaceDocument(sourceId, doc, chunks, embedModel) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO documents (source_id, path, title, language, content_hash, allow_llm, mtime, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (source_id, path) DO UPDATE SET
               title = EXCLUDED.title,
               language = EXCLUDED.language,
               content_hash = EXCLUDED.content_hash,
               allow_llm = EXCLUDED.allow_llm,
               mtime = EXCLUDED.mtime,
               tags = EXCLUDED.tags,
               updated_at = now()
             RETURNING id`,
            [
              sourceId,
              doc.path,
              stripNul(doc.title),
              doc.language,
              doc.contentHash,
              doc.allowLlm,
              doc.mtime,
              (doc.tags ?? []).map(stripNul),
            ],
          )
          const documentId = rows[0]?.id
          if (documentId === undefined) throw new Error('document upsert returned no row')
          await client.query('DELETE FROM chunks WHERE document_id = $1', [documentId])
          if (chunks.length > 0) {
            await client.query(
              `INSERT INTO chunks (document_id, ordinal, heading_path, start_line, end_line, content, embedding, embed_model)
               SELECT $1, t.ordinal, t.heading_path, t.start_line, t.end_line, t.content, t.embedding::vector, $8
               FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::text[], $7::text[])
                 AS t (ordinal, heading_path, start_line, end_line, content, embedding)`,
              [
                documentId,
                chunks.map((chunk) => chunk.ordinal),
                chunks.map((chunk) => stripNul(chunk.headingPath)),
                chunks.map((chunk) => chunk.startLine),
                chunks.map((chunk) => chunk.endLine),
                chunks.map((chunk) => stripNul(chunk.content)),
                chunks.map((chunk) => toVectorLiteral(chunk.embedding)),
                embedModel,
              ],
            )
          }
          // The map vector and the link rows (R20) follow the chunks in the same transaction.
          const source = await client.query<{ kind: string }>('SELECT kind FROM sources WHERE id = $1', [sourceId])
          await refreshDocumentVector(client, documentId, source.rows[0]?.kind ?? '', doc.path)
          await writeLinks(client, documentId, doc.links ?? [])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async replaceLinks(sourceId, path, links) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const { rows } = await client.query<{ id: string }>(
            'SELECT id FROM documents WHERE source_id = $1 AND path = $2 FOR UPDATE',
            [sourceId, path],
          )
          const documentId = rows[0]?.id
          if (documentId !== undefined) {
            await writeLinks(client, documentId, links)
            // New link rows are a change the offline copy must get (R11, T72).
            await client.query('UPDATE documents SET sync_seq = sync_seq WHERE id = $1', [documentId])
          }
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async setAllowLlm(sourceId, path, allowLlm, tags) {
      await pool.query(
        `UPDATE documents SET allow_llm = $3, tags = COALESCE($4::text[], tags), updated_at = now()
         WHERE source_id = $1 AND path = $2`,
        [sourceId, path, allowLlm, tags === undefined ? null : tags.map(stripNul)],
      )
    },

    async deleteDocuments(sourceId, paths) {
      if (paths.length === 0) return 0
      const result = await pool.query('DELETE FROM documents WHERE source_id = $1 AND path = ANY ($2::text[])', [
        sourceId,
        [...paths],
      ])
      return result.rowCount ?? 0
    },
  }
}

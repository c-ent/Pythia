import type { Pool } from 'pg'

/** Every kind except `work`, which default ingestion never creates (R2). */
export type IngestSourceKind = 'obsidian' | 'keep' | 'repo' | 'chat'

export interface SourceRow {
  id: number
  enabled: boolean
}

export interface DocumentState {
  contentHash: string
  allowLlm: boolean
  /** Some chunk was embedded with a different model (or none) and needs re-embedding. */
  stale: boolean
}

export interface DocumentWrite {
  path: string
  title: string
  language: string | null
  contentHash: string
  allowLlm: boolean
  mtime: Date | null
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
  /** Upserts the document and replaces all of its chunks in one transaction. */
  replaceDocument(sourceId: number, doc: DocumentWrite, chunks: readonly ChunkWrite[], embedModel: string): Promise<void>
  setAllowLlm(sourceId: number, path: string, allowLlm: boolean): Promise<void>
  /** Deletes the documents (chunks cascade) and returns how many existed. */
  deleteDocuments(sourceId: number, paths: readonly string[]): Promise<number>
}

/** Postgres rejects NUL in text columns; a stray one must not fail the whole note. */
const stripNul = (text: string): string => text.replaceAll('\u0000', '')

const toVectorLiteral = (vector: readonly number[]): string => `[${vector.join(',')}]`

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
      const { rows } = await pool.query<{ path: string; content_hash: string; allow_llm: boolean; stale: boolean }>(
        `SELECT d.path, d.content_hash, d.allow_llm,
                EXISTS (
                  SELECT 1 FROM chunks c
                  WHERE c.document_id = d.id AND c.embed_model IS DISTINCT FROM $2
                ) AS stale
         FROM documents d
         WHERE d.source_id = $1 AND ($3::text[] IS NULL OR d.path = ANY ($3::text[]))`,
        [sourceId, embedModel, paths === undefined ? null : [...paths]],
      )
      return new Map(
        rows.map((row) => [row.path, { contentHash: row.content_hash, allowLlm: row.allow_llm, stale: row.stale }]),
      )
    },

    async replaceDocument(sourceId, doc, chunks, embedModel) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO documents (source_id, path, title, language, content_hash, allow_llm, mtime)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (source_id, path) DO UPDATE SET
               title = EXCLUDED.title,
               language = EXCLUDED.language,
               content_hash = EXCLUDED.content_hash,
               allow_llm = EXCLUDED.allow_llm,
               mtime = EXCLUDED.mtime,
               updated_at = now()
             RETURNING id`,
            [sourceId, doc.path, stripNul(doc.title), doc.language, doc.contentHash, doc.allowLlm, doc.mtime],
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
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async setAllowLlm(sourceId, path, allowLlm) {
      await pool.query('UPDATE documents SET allow_llm = $3, updated_at = now() WHERE source_id = $1 AND path = $2', [
        sourceId,
        path,
        allowLlm,
      ])
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

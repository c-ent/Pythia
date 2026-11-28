import type { Pool, PoolClient } from 'pg'
import { isMapDocument } from '../ingest/mapEligible.js'

/**
 * `document_vectors` (R20, T65): one row per map document, the mean of its
 * chunk embeddings and their `embed_model`. Computed in Postgres from the
 * stored chunks, so writing or backfilling a vector never calls the embedder.
 */

type Queryable = Pick<Pool | PoolClient, 'query'>

// Mixed models in one document only happen while it waits to be re-embedded;
// the model most of its chunks use wins until then.
const MEAN_BY_DOCUMENT = `
  SELECT DISTINCT ON (g.document_id) g.document_id, g.embedding, g.embed_model
  FROM (
    SELECT c.document_id, c.embed_model, avg(c.embedding) AS embedding, count(*) AS n
    FROM chunks c
    WHERE c.document_id = ANY ($1::bigint[]) AND c.embedding IS NOT NULL AND c.embed_model IS NOT NULL
    GROUP BY c.document_id, c.embed_model
  ) g
  ORDER BY g.document_id, g.n DESC, g.embed_model`

/**
 * Writes or removes the vector of one document after its chunks changed.
 * A map document with stored chunks gets the mean of their embeddings; any
 * other document (not on the R20 list, or every chunk dropped) has no row.
 */
export async function refreshDocumentVector(
  db: Queryable,
  documentId: number | string,
  kind: string,
  docPath: string,
): Promise<void> {
  if (!isMapDocument(kind, docPath)) {
    await db.query('DELETE FROM document_vectors WHERE document_id = $1', [documentId])
    return
  }
  const written = await db.query(
    `INSERT INTO document_vectors (document_id, embedding, embed_model)
     ${MEAN_BY_DOCUMENT}
     ON CONFLICT (document_id) DO UPDATE SET
       embedding = EXCLUDED.embedding,
       embed_model = EXCLUDED.embed_model,
       updated_at = now()`,
    [[documentId]],
  )
  if ((written.rowCount ?? 0) === 0) {
    await db.query('DELETE FROM document_vectors WHERE document_id = $1', [documentId])
  }
}

/**
 * Gives every map document that has stored chunks but no vector yet its
 * vector, from the stored chunk embeddings. Used once per startup, so
 * documents indexed before `document_vectors` existed join the map without
 * being re-embedded. Returns how many vectors were written.
 */
export async function backfillDocumentVectors(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string; kind: string; path: string }>(
    `SELECT d.id, s.kind, d.path
     FROM documents d
     JOIN sources s ON s.id = d.source_id
     WHERE s.kind <> 'work'
       AND NOT EXISTS (SELECT 1 FROM document_vectors v WHERE v.document_id = d.id)
       AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id AND c.embedding IS NOT NULL)`,
  )
  const ids = rows.filter((row) => isMapDocument(row.kind, row.path)).map((row) => row.id)
  if (ids.length === 0) return 0
  // A document re-indexed meanwhile already has its fresh vector; keep it.
  // The document joins the map, so the offline copy must hear of it (R11,
  // T72): touching it gives it a new sync sequence value (002_sync.sql).
  const result = await pool.query(
    `WITH written AS (
       INSERT INTO document_vectors (document_id, embedding, embed_model)
       ${MEAN_BY_DOCUMENT}
       ON CONFLICT (document_id) DO NOTHING
       RETURNING document_id
     )
     UPDATE documents d SET sync_seq = d.sync_seq FROM written w WHERE d.id = w.document_id`,
    [ids],
  )
  return result.rowCount ?? 0
}

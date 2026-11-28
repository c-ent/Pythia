import type { Pool } from 'pg'
import {
  buildExclusionCatalog,
  type LlmExclusion,
  type LlmExclusionCatalog,
  type LlmExclusionKind,
  type LlmExclusionStore,
} from '../ingest/llmExclusions.js'

// Vault notes: only tightens. Notes the new list no longer excludes keep
// allow_llm = false until `VaultIndexer.refreshAllowLlm` has read their
// frontmatter (`llm: false` must still hold).
const TIGHTEN_VAULT_SQL = `
  UPDATE documents AS d SET allow_llm = false, updated_at = now()
  FROM sources s
  WHERE s.id = d.source_id AND s.kind = 'obsidian' AND d.allow_llm
    AND EXISTS (
      SELECT 1 FROM llm_exclusions e
      WHERE (e.kind = 'folder' AND starts_with(lower(d.path), lower(e.path) || '/'))
         OR (e.kind = 'note' AND lower(d.path) = lower(e.path))
         OR (e.kind = 'tag' AND EXISTS (
               SELECT 1 FROM unnest(d.tags) AS t (tag)
               WHERE t.tag = lower(e.path) OR starts_with(t.tag, lower(e.path) || '/')
             ))
    )`

// Repos and Keep have no per-document opt-out, so the rule alone decides,
// both ways.
const APPLY_REPO_SQL = `
  UPDATE documents AS d SET allow_llm = x.allowed, updated_at = now()
  FROM (
    SELECT s.id, NOT EXISTS (
      SELECT 1 FROM llm_exclusions e WHERE e.kind = 'repo' AND lower(e.path) = lower(s.name)
    ) AS allowed
    FROM sources s WHERE s.kind = 'repo'
  ) AS x
  WHERE d.source_id = x.id AND d.allow_llm IS DISTINCT FROM x.allowed`

const APPLY_KEEP_SQL = `
  UPDATE documents AS d SET allow_llm = x.allowed, updated_at = now()
  FROM (
    SELECT s.id, NOT EXISTS (SELECT 1 FROM llm_exclusions e WHERE e.kind = 'keep') AS allowed
    FROM sources s WHERE s.kind = 'keep'
  ) AS x
  WHERE d.source_id = x.id AND d.allow_llm IS DISTINCT FROM x.allowed`

// Drive (R19, T62): a `gdrive` rule covers the whole Drive (`/`) or a folder
// and its subfolders, ignoring case. Documents a rule covers are locked at
// once. Documents no rule covers are given back here too, except Markdown
// files: they can carry frontmatter `llm: false`, so the next Drive round
// (DriveIndexer.fullScan) re-reads them and gives them back if allowed.
const APPLY_DRIVE_SQL = `
  UPDATE documents AS d SET allow_llm = x.allowed, updated_at = now()
  FROM (
    SELECT d2.id, NOT EXISTS (
      SELECT 1 FROM llm_exclusions e
      WHERE e.kind = 'gdrive' AND (e.path = '/' OR starts_with(lower(d2.path), lower(e.path) || '/'))
    ) AS allowed, lower(d2.path) LIKE '%.md' AS markdown
    FROM documents d2 JOIN sources s ON s.id = d2.source_id
    WHERE s.kind = 'gdrive'
  ) AS x
  WHERE d.id = x.id AND d.allow_llm IS DISTINCT FROM x.allowed AND (NOT x.allowed OR NOT x.markdown)`

// Documents each rule covers, whatever their allow_llm (an `llm: false` note
// in a listed folder still counts).
const COUNT_SQL = `
  SELECT r.i, (
    SELECT count(*) FROM documents d JOIN sources s ON s.id = d.source_id
    WHERE CASE r.kind
      WHEN 'folder' THEN s.kind = 'obsidian' AND starts_with(lower(d.path), lower(r.path) || '/')
      WHEN 'note' THEN s.kind = 'obsidian' AND lower(d.path) = lower(r.path)
      WHEN 'tag' THEN s.kind = 'obsidian' AND EXISTS (
        SELECT 1 FROM unnest(d.tags) AS t (tag)
        WHERE t.tag = lower(r.path) OR starts_with(t.tag, lower(r.path) || '/')
      )
      WHEN 'repo' THEN s.kind = 'repo' AND lower(s.name) = lower(r.path)
      WHEN 'keep' THEN s.kind = 'keep'
      WHEN 'gdrive' THEN s.kind = 'gdrive' AND (r.path = '/' OR starts_with(lower(d.path), lower(r.path) || '/'))
      ELSE false
    END
  ) AS n
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r (kind, path, i)
  ORDER BY r.i`

const KIND_ORDER_SQL = `CASE kind WHEN 'folder' THEN 0 WHEN 'note' THEN 1 WHEN 'tag' THEN 2 WHEN 'repo' THEN 3 WHEN 'keep' THEN 4 ELSE 5 END`

export function createPgLlmExclusionStore(pool: Pool): LlmExclusionStore {
  return {
    async list() {
      const { rows } = await pool.query<{ kind: LlmExclusionKind; path: string }>(
        `SELECT kind, path FROM llm_exclusions ORDER BY ${KIND_ORDER_SQL}, lower(path), path`,
      )
      return rows.map((row): LlmExclusion => ({ kind: row.kind, path: row.path }))
    },

    async replace(list) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await client.query('DELETE FROM llm_exclusions')
          if (list.length > 0) {
            await client.query('INSERT INTO llm_exclusions (kind, path) SELECT * FROM unnest($1::text[], $2::text[])', [
              list.map((exclusion) => exclusion.kind),
              list.map((exclusion) => exclusion.path),
            ])
          }
          await client.query(TIGHTEN_VAULT_SQL)
          await client.query(APPLY_REPO_SQL)
          await client.query(APPLY_KEEP_SQL)
          await client.query(APPLY_DRIVE_SQL)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async countDocuments(list) {
      if (list.length === 0) return []
      const { rows } = await pool.query<{ i: string; n: string }>(COUNT_SQL, [
        list.map((exclusion) => exclusion.kind),
        list.map((exclusion) => exclusion.path),
      ])
      return rows.map((row) => Number(row.n))
    },
  }
}

/** Reads indexed Obsidian folders/notes/tags, Drive folders/files and Keep count for Settings. */
export async function readPgLlmExclusionCatalog(pool: Pool): Promise<LlmExclusionCatalog> {
  const [docsResult, keepResult] = await Promise.all([
    pool.query<{ kind: 'obsidian' | 'gdrive'; path: string; tags: string[] }>(
      `SELECT s.kind, d.path, d.tags
       FROM documents d
       JOIN sources s ON s.id = d.source_id
       WHERE s.kind IN ('obsidian', 'gdrive') AND s.enabled
       ORDER BY lower(d.path), d.path`,
    ),
    pool.query<{ n: string }>(
      `SELECT count(*) AS n
       FROM documents d
       JOIN sources s ON s.id = d.source_id
       WHERE s.kind = 'keep' AND s.enabled`,
    ),
  ])
  const obsidianDocs: { path: string; tags: string[] }[] = []
  const drivePaths: string[] = []
  for (const row of docsResult.rows) {
    if (row.kind === 'obsidian') obsidianDocs.push({ path: row.path, tags: row.tags })
    else drivePaths.push(row.path)
  }
  return buildExclusionCatalog({
    obsidianDocs,
    drivePaths,
    keepDocuments: Number(keepResult.rows[0]?.n ?? 0),
  })
}

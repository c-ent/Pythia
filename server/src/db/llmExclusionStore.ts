import type { Pool } from 'pg'
import type { LlmExclusion, LlmExclusionKind, LlmExclusionStore } from '../ingest/llmExclusions.js'

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
      ELSE false
    END
  ) AS n
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r (kind, path, i)
  ORDER BY r.i`

const KIND_ORDER_SQL = `CASE kind WHEN 'folder' THEN 0 WHEN 'note' THEN 1 WHEN 'tag' THEN 2 WHEN 'repo' THEN 3 ELSE 4 END`

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

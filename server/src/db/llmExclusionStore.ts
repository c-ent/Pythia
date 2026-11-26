import type { Pool } from 'pg'
import type { LlmExclusion, LlmExclusionKind, LlmExclusionStore } from '../ingest/llmExclusions.js'

// Only tightens: notes the new list no longer excludes keep allow_llm = false
// until `VaultIndexer.refreshAllowLlm` has read their frontmatter.
const TIGHTEN_SQL = `
  UPDATE documents AS d SET allow_llm = false, updated_at = now()
  FROM sources s
  WHERE s.id = d.source_id AND s.kind = 'obsidian' AND d.allow_llm
    AND EXISTS (
      SELECT 1 FROM llm_exclusions e
      WHERE (e.kind = 'folder' AND starts_with(lower(d.path), lower(e.path) || '/'))
         OR (e.kind = 'note' AND lower(d.path) = lower(e.path))
    )`

export function createPgLlmExclusionStore(pool: Pool): LlmExclusionStore {
  return {
    async list() {
      const { rows } = await pool.query<{ kind: LlmExclusionKind; path: string }>(
        'SELECT kind, path FROM llm_exclusions ORDER BY kind, lower(path), path',
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
          await client.query(TIGHTEN_SQL)
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },
  }
}

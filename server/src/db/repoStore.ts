import type { Pool } from 'pg'

/**
 * Document path of a repo's `SUMMARY` document (written by
 * `ingest/repoIndexer.ts`). The leading `:` cannot start a tracked file the
 * indexer keeps, so it never collides with a real path.
 */
export const SUMMARY_PATH = ':SUMMARY'

export interface RepoRow {
  name: string
  /** Indexed files, the SUMMARY document not counted. */
  files: number
  chunks: number
  /** Last time any of its documents changed; null before the first index. */
  updatedAt: Date | null
}

export interface RepoOverviewRow extends RepoRow {
  summary: { documentId: number; allowLlm: boolean; content: string } | null
}

/** What the repo service needs from the database. Tests stub the service instead. */
export interface RepoStore {
  /** Enabled `kind = 'repo'` sources, by name. */
  listRepos(): Promise<RepoRow[]>
  /** Null for an unknown or disabled repo. */
  getRepo(name: string): Promise<RepoOverviewRow | null>
}

const REPO_COLUMNS = `
  s.name,
  (SELECT count(*) FROM documents d WHERE d.source_id = s.id AND d.path <> '${SUMMARY_PATH}') AS files,
  (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_id = s.id) AS chunks,
  (SELECT max(d.updated_at) FROM documents d WHERE d.source_id = s.id) AS updated_at`

interface RepoDbRow {
  id: string
  name: string
  files: string
  chunks: string
  updated_at: Date | null
}

const toRepo = (row: RepoDbRow): RepoRow => ({
  name: row.name,
  files: Number(row.files),
  chunks: Number(row.chunks),
  updatedAt: row.updated_at,
})

export function createPgRepoStore(pool: Pool): RepoStore {
  return {
    async listRepos() {
      const { rows } = await pool.query<RepoDbRow>(
        `SELECT s.id, ${REPO_COLUMNS} FROM sources s WHERE s.kind = 'repo' AND s.enabled ORDER BY s.name`,
      )
      return rows.map(toRepo)
    },

    async getRepo(name) {
      const { rows } = await pool.query<RepoDbRow>(
        `SELECT s.id, ${REPO_COLUMNS} FROM sources s WHERE s.kind = 'repo' AND s.enabled AND s.name = $1`,
        [name],
      )
      const row = rows[0]
      if (row === undefined) return null
      const summary = await pool.query<{ id: string; allow_llm: boolean; content: string | null }>(
        `SELECT d.id, d.allow_llm,
                (SELECT string_agg(c.content, E'\\n\\n' ORDER BY c.ordinal) FROM chunks c WHERE c.document_id = d.id) AS content
         FROM documents d WHERE d.source_id = $1 AND d.path = $2`,
        [row.id, SUMMARY_PATH],
      )
      const doc = summary.rows[0]
      return {
        ...toRepo(row),
        summary:
          doc === undefined ? null : { documentId: Number(doc.id), allowLlm: doc.allow_llm, content: doc.content ?? '' },
      }
    },
  }
}

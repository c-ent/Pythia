import type { RepoOverviewRow, RepoRow, RepoStore } from '../db/repoStore.js'

/**
 * Repo list and overviews (R9, R7) for `GET /api/repos` and the
 * `list_repos` / `get_repo_overview` MCP tools. The overview text is the
 * repo's deterministic `SUMMARY` document from the ingest pipeline.
 */

export interface RepoInfo {
  name: string
  files: number
  chunks: number
  updatedAt: Date | null
}

export interface RepoOverview extends RepoInfo {
  /** Null until the repo has been indexed once. */
  summary: { documentId: number; allowLlm: boolean; text: string } | null
}

export interface RepoService {
  listRepos(): Promise<RepoInfo[]>
  /** Null for an unknown or disabled repo. */
  getOverview(name: string): Promise<RepoOverview | null>
}

const toInfo = (row: RepoRow): RepoInfo => ({
  name: row.name,
  files: row.files,
  chunks: row.chunks,
  updatedAt: row.updatedAt,
})

const toOverview = (row: RepoOverviewRow): RepoOverview => ({
  ...toInfo(row),
  summary:
    row.summary === null
      ? null
      : { documentId: row.summary.documentId, allowLlm: row.summary.allowLlm, text: row.summary.content },
})

export function createRepoService(options: { store: RepoStore }): RepoService {
  const { store } = options
  return {
    async listRepos() {
      return (await store.listRepos()).map(toInfo)
    },
    async getOverview(name) {
      const row = await store.getRepo(name)
      return row === null ? null : toOverview(row)
    },
  }
}

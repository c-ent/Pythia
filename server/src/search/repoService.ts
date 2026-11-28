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

export interface RepoSummaryMetadata {
  firstCommitAt: Date | null
  lastCommitAt: Date | null
  languages: string | null
}

const parseIsoField = (content: string, prefix: string): Date | null => {
  const match = new RegExp(`^${prefix}:\\s*(.+)$`, 'm').exec(content)
  if (match?.[1] === undefined) return null
  const ms = Date.parse(match[1].trim())
  return Number.isNaN(ms) ? null : new Date(ms)
}

const parseLineField = (content: string, prefix: string): string | null => {
  const match = new RegExp(`^${prefix}:\\s*(.+)$`, 'm').exec(content)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? null : value
}

/** Extracts commit dates and language summary from a repo's deterministic `SUMMARY` document. */
export function parseRepoSummaryMetadata(content: string, fallbackLastCommitAt: Date | null = null): RepoSummaryMetadata {
  return {
    firstCommitAt: parseIsoField(content, 'First commit'),
    lastCommitAt: parseIsoField(content, 'Latest commit') ?? fallbackLastCommitAt,
    languages: parseLineField(content, 'Languages'),
  }
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

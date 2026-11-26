import { apiFetch } from './client'

// Mirrors `GET /api/repos` and `GET /api/repos/:name` (server/src/search/repoService.ts).
// Dates arrive as ISO strings.

export interface RepoInfo {
  name: string
  files: number
  chunks: number
  updatedAt: string | null
}

export interface RepoOverview extends RepoInfo {
  /** The repo's `SUMMARY` document; null until the repo has been indexed once. */
  summary: { documentId: number; allowLlm: boolean; text: string } | null
}

export async function listRepos(signal?: AbortSignal): Promise<RepoInfo[]> {
  const res = await apiFetch('/api/repos', { signal })
  return ((await res.json()) as { repos: RepoInfo[] }).repos
}

export async function getRepoOverview(name: string, signal?: AbortSignal): Promise<RepoOverview> {
  const res = await apiFetch(`/api/repos/${encodeURIComponent(name)}`, { signal })
  return (await res.json()) as RepoOverview
}

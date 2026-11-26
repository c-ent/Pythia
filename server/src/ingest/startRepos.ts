import path from 'node:path'
import type { Pool } from 'pg'
import type { ReposConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { loadRepoConfig } from './repoConfig.js'
import { indexRepoCommit, type RepoIndexResult } from './repoIndexer.js'
import { mirrorPath } from './repoMirror.js'
import { startRepoScheduler, type RepoScheduler } from './repoScheduler.js'

export interface RunningRepos {
  /** Fetch and index round on demand (Import page re-index); absent when the config did not load. */
  runNow?: () => Promise<unknown>
  close(): Promise<void>
}

const summarize = (result: RepoIndexResult) => ({
  indexed: result.indexed.length,
  unchanged: result.unchanged,
  deleted: result.deleted.length,
  failed: result.failed.length,
  summary: result.summary,
})

/**
 * Loads the repo list, starts the fetch scheduler and indexes each fetched
 * commit. A bad config file or a failing repo is logged, never fatal: the
 * server keeps serving the existing index. Logs carry repo names and counts,
 * never URLs, tokens or file content.
 */
export async function startRepos(pool: Pool, repos: ReposConfig, embedder: Embedder): Promise<RunningRepos> {
  let specs
  try {
    specs = await loadRepoConfig(repos.configFile)
  } catch (error) {
    console.error('repo config not loaded; repo fetching is off:', error instanceof Error ? error.message : error)
    return { close: async () => {} }
  }
  console.log(`repos: ${specs.length} configured, fetch every ${Math.round(repos.fetchIntervalMs / 60_000)} min`)
  const mirrorsDir = path.resolve(repos.mirrorsDir)
  const mirror = { mirrorsDir, githubToken: repos.githubToken }
  const store = createPgIndexStore(pool)

  const scheduler: RepoScheduler = startRepoScheduler({
    repos: specs,
    ...mirror,
    intervalMs: repos.fetchIntervalMs,
    async onSynced(synced, spec) {
      const dir = mirrorPath(mirrorsDir, spec.name)
      const source = await ensureSource(pool, 'repo', spec.name, dir)
      if (!source.enabled) {
        console.log(`repo ${spec.name} is disabled; not indexing`)
        return
      }
      const result = await indexRepoCommit(
        { repo: spec.name, branch: spec.branch, dir, sourceId: source.id, store, embedder, mirror },
        synced.commit,
      )
      console.log(`repo ${spec.name} indexed`, summarize(result))
    },
  })
  return { runNow: () => scheduler.runNow(), close: () => scheduler.close() }
}

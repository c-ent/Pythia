import path from 'node:path'
import type { Pool } from 'pg'
import type { ReposConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { createRepoActivity, type ActivityLog } from '../sync/activity.js'
import { isRepoLocked, type LlmExclusionStore } from './llmExclusions.js'
import { loadRepoConfig } from './repoConfig.js'
import { indexRepoCommit, type RepoIndexResult } from './repoIndexer.js'
import { mirrorPath } from './repoMirror.js'
import { startRepoScheduler, type RepoRoundResult, type RepoScheduler } from './repoScheduler.js'

export interface RunningRepos {
  /** Fetch and index round on demand (Import page re-index, Sync now); absent when the config did not load. */
  runNow?: () => Promise<unknown>
  /** Fetches one configured repo (Repos page re-sync); null for a name not in the config. */
  runOne?: (name: string) => Promise<RepoRoundResult> | null
  /** Configured repo names, in config order; empty when the config did not load. */
  names: readonly string[]
  /** Time between fetch rounds, in ms. */
  intervalMs: number
  /** Set when the config file did not load: a short reason, never file content. */
  configError: string | null
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
 * never URLs, tokens or file content; activity events (R18) carry repo names,
 * counts and an error class only.
 */
export async function startRepos(
  pool: Pool,
  repos: ReposConfig,
  embedder: Embedder,
  exclusions?: Pick<LlmExclusionStore, 'list'>,
  activity?: ActivityLog,
): Promise<RunningRepos> {
  let specs
  try {
    specs = await loadRepoConfig(repos.configFile)
  } catch (error) {
    console.error('repo config not loaded; repo fetching is off:', error instanceof Error ? error.message : error)
    const name = error instanceof Error ? error.name : 'unknown error'
    return { names: [], intervalMs: repos.fetchIntervalMs, configError: `repo config not loaded: ${name}`, close: async () => {} }
  }
  console.log(`repos: ${specs.length} configured, fetch every ${Math.round(repos.fetchIntervalMs / 60_000)} min`)
  const mirrorsDir = path.resolve(repos.mirrorsDir)
  const mirror = { mirrorsDir, githubToken: repos.githubToken }
  const store = createPgIndexStore(pool)
  const recorder = createRepoActivity(activity)

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
      // Read every round, so a lock set under Settings holds for the next commit too.
      const allowLlm = !isRepoLocked(spec.name, (await exclusions?.list()) ?? [])
      const result = await indexRepoCommit(
        {
          repo: spec.name,
          branch: spec.branch,
          dir,
          sourceId: source.id,
          store,
          embedder,
          mirror,
          allowLlm,
          logSecrets: recorder.logSecrets,
        },
        synced.commit,
      )
      console.log(`repo ${spec.name} indexed`, summarize(result))
    },
    onFailed: (spec, error) => recorder.failed(spec.name, error),
    async onRound(result) {
      console.log('repo fetch round', {
        synced: result.synced.length,
        cloned: result.synced.filter((repo) => repo.cloned).length,
        failed: result.failed.map((failure) => failure.name),
      })
      await recorder.round(result)
    },
    onSingle: (name, result) => recorder.single(name, result),
  })
  return {
    runNow: () => scheduler.runNow(),
    runOne: (name) => scheduler.runOne(name),
    names: specs.map((spec) => spec.name),
    intervalMs: repos.fetchIntervalMs,
    configError: null,
    close: () => scheduler.close(),
  }
}

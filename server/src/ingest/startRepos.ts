import path from 'node:path'
import type { Pool } from 'pg'
import type { ReposConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { createRepoActivity, type ActivityLog } from '../sync/activity.js'
import { isRepoLocked, type LlmExclusionStore } from './llmExclusions.js'
import { loadRepoConfigFile, type RepoSpec } from './repoConfig.js'
import { createRepoDiscovery, listOwnedRepos, type RepoDiscover } from './repoDiscovery.js'
import { indexRepoCommit, type RepoIndexResult } from './repoIndexer.js'
import { mirrorPath, RepoSyncError } from './repoMirror.js'
import { startRepoScheduler, type RepoRoundResult, type RepoScheduler } from './repoScheduler.js'

export interface RunningRepos {
  /** Fetch and index round on demand (Import page re-index, Sync now); absent when the config did not load. */
  runNow?: () => Promise<unknown>
  /** Fetches one configured repo (Repos page re-sync); null for a name not in the config. */
  runOne?: (name: string) => Promise<RepoRoundResult> | null
  /** The scheduler's round state for Status (T52); absent when the config did not load. */
  state?: () => { running: boolean; repo: string | null }
  /** Live progress during a round or single fetch, or null when idle. */
  progress?: () => { stage: 'fetching' | 'indexing'; done: number; total: number; item: string | null } | null
  /** Repo names in config order, then any added by discovery (T54); empty when the config did not load. */
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

const REMOTE_URL = /(?:https?|ssh|file):\/\/[^\s'"<>]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s'"<>]+/gi
const TOKEN_LIKE = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g

/**
 * Redacts remote URLs, credentials and tokens so server logs explain why a
 * repo sync failed without exposing URLs, tokens or file content.
 */
export function describeRepoFailure(error: unknown): string {
  if (error instanceof RepoSyncError) {
    return error.message
      .replace(/\/\/[^/@\s]+@/g, '//***@')
      .replace(REMOTE_URL, '<remote>')
      .replace(TOKEN_LIKE, '<token>')
      .slice(0, 300)
  }
  if (error instanceof Error) {
    const name = error.name !== '' ? error.name : 'Error'
    const code = 'code' in error && typeof error.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
    return `${name}${code}`
  }
  return 'unknown error'
}

/**
 * Loads the repo list, starts the fetch scheduler and indexes each fetched
 * commit. A bad config file or a failing repo is logged, never fatal: the
 * server keeps serving the existing index. Logs carry repo names, counts and
 * redacted git error reasons, never URLs, tokens or file content; activity
 * events (R18) carry repo names, counts and fixed safe reasons or error classes.
 */
export async function startRepos(
  pool: Pool,
  repos: ReposConfig,
  embedder: Embedder,
  exclusions?: Pick<LlmExclusionStore, 'list'>,
  activity?: ActivityLog,
): Promise<RunningRepos> {
  let file
  try {
    file = await loadRepoConfigFile(repos.configFile)
  } catch (error) {
    console.error('repo config not loaded; repo fetching is off:', error instanceof Error ? error.message : error)
    const name = error instanceof Error ? error.name : 'unknown error'
    return { names: [], intervalMs: repos.fetchIntervalMs, configError: `repo config not loaded: ${name}`, close: async () => {} }
  }
  const specs = file.repos
  console.log(`repos: ${specs.length} configured, fetch every ${Math.round(repos.fetchIntervalMs / 60_000)} min`)
  const mirrorsDir = path.resolve(repos.mirrorsDir)
  const mirror = { mirrorsDir, githubToken: repos.githubToken }
  const store = createPgIndexStore(pool)
  const recorder = createRepoActivity(activity)
  // Shared with Status, which reads it on every request, so repos added by
  // discovery show up there without a restart. Only ever grows.
  const names = specs.map((spec) => spec.name)

  // Repo discovery (T54): on by default, off with PYTHIA_REPOS_DISCOVER=0; it needs the token.
  let discover: RepoDiscover | undefined
  const token = repos.githubToken
  if (!repos.discover) {
    console.log('repo discovery: off (PYTHIA_REPOS_DISCOVER=0)')
  } else if (token === null) {
    console.log('repo discovery: off, it needs GITHUB_TOKEN')
  } else {
    console.log(`repo discovery: on, ${file.exclude.length} excluded`)
    discover = createRepoDiscovery({
      list: () => listOwnedRepos({ token }),
      configured: file.configured,
      exclude: file.exclude,
    })
  }

  const scheduler: RepoScheduler = startRepoScheduler({
    repos: specs,
    ...mirror,
    intervalMs: repos.fetchIntervalMs,
    ...(discover === undefined
      ? {}
      : { discover, onDiscovered: (added: readonly RepoSpec[]) => names.push(...added.map((spec) => spec.name)) }),
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
    onFailed(spec, error) {
      console.error(`repo ${spec.name} sync failed: ${describeRepoFailure(error)}`)
      recorder.failed(spec.name, error)
    },
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
    state: () => scheduler.state(),
    progress: () => scheduler.progress(),
    names,
    intervalMs: repos.fetchIntervalMs,
    configError: null,
    close: () => scheduler.close(),
  }
}

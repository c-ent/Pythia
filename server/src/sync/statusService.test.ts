import { describe, expect, it } from 'vitest'
import type { SourceStatusRow } from '../db/statusStore.js'
import type { RepoSpec } from '../ingest/repoConfig.js'
import type { SyncResult } from '../ingest/repoMirror.js'
import { startRepoScheduler } from '../ingest/repoScheduler.js'
import { createActivityLog, createMemoryActivityStore } from './activity.js'
import { createStatusService } from './statusService.js'
import { createSyncNow } from './syncNow.js'

// T52: a scheduled repo round (the startup round and every 30-minute round)
// shows as syncing, not only a run started by Sync now.

const specs: RepoSpec[] = [
  { name: 'pythia', url: '/tmp/pythia', branch: null },
  { name: 'notes', url: '/tmp/notes', branch: null },
]

const rows: SourceStatusRow[] = [
  { kind: 'repo', name: 'pythia', enabled: true, documents: 5, chunks: 15, updatedAt: null },
  { kind: 'repo', name: 'notes', enabled: true, documents: 2, chunks: 6, updatedAt: null },
]

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

/** A scheduler whose fetch of each repo waits until the test opens that repo's gate. */
function setup() {
  const gates = new Map(specs.map((spec) => [spec.name, gate()]))
  const started: string[] = []
  const scheduler = startRepoScheduler({
    repos: specs,
    mirrorsDir: '/m',
    sync: async (spec): Promise<SyncResult> => {
      started.push(spec.name)
      await gates.get(spec.name)!.promise
      return { name: spec.name, cloned: false, commit: `${spec.name}-sha` }
    },
    onRound: () => {},
  })
  const syncNow = createSyncNow({ log: () => {} })
  const status = createStatusService({
    sources: { listSources: async () => rows },
    activity: createActivityLog(createMemoryActivityStore()),
    vault: null,
    repos: { names: specs.map((spec) => spec.name), intervalMs: 30 * 60_000, configError: null },
    syncing: () => syncNow.state(),
    repoRound: () => scheduler.state(),
    log: () => {},
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve))
    expect(check()).toBe(true)
  }
  return { scheduler, status, gates, started, until }
}

describe('createStatusService with a scheduled repo round (T52)', () => {
  it('reports syncing while the startup round runs, per repo as it is fetched, and not after it', async () => {
    const { scheduler, status, gates, started, until } = setup()
    // The scheduler starts its first round by itself; nobody pressed Sync now.
    await until(() => started.includes('pythia'))

    let result = await status.status()
    expect(result.syncing).toBe(true)
    expect(result.sources.find((source) => source.id === 'github')?.syncing).toBe(true)
    expect(result.repos.map((repo) => [repo.name, repo.syncing])).toEqual([
      ['pythia', true],
      ['notes', false],
    ])

    gates.get('pythia')!.open()
    await until(() => started.includes('notes'))
    result = await status.status()
    expect(result.syncing).toBe(true)
    expect(result.repos.map((repo) => [repo.name, repo.syncing])).toEqual([
      ['pythia', false],
      ['notes', true],
    ])

    gates.get('notes')!.open()
    await until(() => !scheduler.state().running)
    result = await status.status()
    expect(result.syncing).toBe(false)
    expect(result.sources.find((source) => source.id === 'github')?.syncing).toBe(false)
    expect(result.repos.every((repo) => !repo.syncing)).toBe(true)
    await scheduler.close()
  })

  it('ignores the round state when repos are off', async () => {
    const status = createStatusService({
      sources: { listSources: async () => [] },
      activity: createActivityLog(createMemoryActivityStore()),
      vault: null,
      repos: null,
      repoRound: () => ({ running: true, repo: 'pythia' }),
      log: () => {},
    })
    const result = await status.status()
    expect(result.syncing).toBe(false)
    expect(result.sources.find((source) => source.id === 'github')?.syncing).toBe(false)
  })
})

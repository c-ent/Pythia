import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import type { SourceStatusRow } from '../db/statusStore.js'
import type { SearchService } from '../search/searchService.js'
import {
  createActivityLog,
  createMemoryActivityStore,
  createRepoActivity,
  createVaultActivity,
  MAX_ACTIVITY,
  type ActivityLog,
} from '../sync/activity.js'
import { createStatusService, type StatusServiceOptions } from '../sync/statusService.js'
import { createSyncNow, type SyncNowOptions } from '../sync/syncNow.js'
import { testAuth } from './testAuth.js'

const { auth, cookie, sessions } = await testAuth()
const search = {} as unknown as SearchService
const ask = {} as unknown as AskService

class FetchError extends Error {
  override name = 'FetchError'
}

const row = (kind: SourceStatusRow['kind'], name: string, documents: number, enabled = true): SourceStatusRow => ({
  kind,
  name,
  enabled,
  documents,
  chunks: documents * 3,
  updatedAt: null,
})

interface Setup {
  rows?: SourceStatusRow[]
  vault?: StatusServiceOptions['vault']
  repos?: StatusServiceOptions['repos']
  sync?: SyncNowOptions
  gemini?: () => Promise<boolean>
  devices?: () => Promise<number>
  repoRound?: StatusServiceOptions['repoRound']
  health?: () => Promise<'ok' | 'warning' | 'broken'>
}

let clock = Date.UTC(2026, 10, 27, 1, 0, 0)
const tick = () => (clock += 1000)
let server: Server | undefined

async function start(setup: Setup = {}) {
  const store = createMemoryActivityStore()
  const activity: ActivityLog = createActivityLog(store, { now: tick })
  const sync = createSyncNow({ ...setup.sync, log: () => {} })
  const rows = setup.rows ?? [row('obsidian', 'vault', 10), row('repo', 'pythia', 5), row('repo', 'notes', 2), row('keep', 'keep', 7)]
  const service = createStatusService({
    sources: { listSources: async () => rows },
    activity,
    devices: setup.devices ?? (async () => (await sessions.list()).length),
    gemini: setup.gemini ?? (async () => true),
    vault: setup.vault === undefined ? { watching: true } : setup.vault,
    repos: setup.repos === undefined ? { names: ['pythia', 'notes'], intervalMs: 30 * 60_000, configError: null } : setup.repos,
    syncing: () => sync.state(),
    ...(setup.repoRound === undefined ? {} : { repoRound: setup.repoRound }),
    now: () => clock,
    log: () => {},
  })
  server = createServer(createApp({ search, ask, auth, status: { service, sync, ...(setup.health === undefined ? {} : { health: { health: setup.health } }) } }))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const get = (path: string) => fetch(`${base}/api${path}`, { headers: { cookie } })
  const post = (path: string) => fetch(`${base}/api${path}`, { method: 'POST', headers: { cookie } })
  const status = async () => {
    const res = await get('/status')
    expect(res.status).toBe(200)
    return (await res.json()) as StatusJson
  }
  return { base, get, post, status, activity, store, sync }
}

interface SourceJson {
  id: string
  kind: string
  state: string
  reason: string | null
  lastSyncAt: string | null
  schedule: { kind: string; everyMinutes: number | null }
  documents: number
  chunks: number
  syncing: boolean
}
interface StatusJson {
  reachable: boolean
  checkedAt: string
  gemini: { available: boolean }
  devices: { active: number }
  documents: Record<string, number>
  syncing: boolean
  sources: SourceJson[]
  repos: Array<{ name: string; state: string; reason: string | null; lastSyncAt: string | null; documents: number; chunks: number; syncing: boolean }>
  activity: Array<{ id: number; at: string; kind: string; source: string | null; count: number | null; message: string | null }>
  health: 'ok' | 'warning' | 'broken'
}

const source = (status: StatusJson, id: string) => status.sources.find((entry) => entry.id === id)!
const repo = (status: StatusJson, name: string) => status.repos.find((entry) => entry.name === name)!

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

afterEach(async () => {
  if (server !== undefined) await new Promise((resolve) => server!.close(resolve))
  server = undefined
})

describe('GET /api/status', () => {
  it('needs a session on every route', async () => {
    const { base } = await start()
    for (const [method, path] of [
      ['GET', '/status'],
      ['GET', '/activity'],
      ['POST', '/sync-now'],
      ['POST', '/repos/pythia/sync'],
    ]) {
      expect((await fetch(`${base}/api${path}`, { method })).status).toBe(401)
    }
  })

  it('reports reachability, Gemini, devices, counts and schedules, and is never cached', async () => {
    const { get } = await start()
    const res = await get('/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const status = (await res.json()) as StatusJson
    expect(status).toMatchObject({
      reachable: true,
      checkedAt: new Date(clock).toISOString(),
      gemini: { available: true },
      devices: { active: 1 },
      documents: { obsidian: 10, keep: 7, repo: 7, chat: 0 },
      syncing: false,
      health: 'ok',
      activity: [],
    })
    expect(status.sources.map((entry) => [entry.id, entry.kind, entry.state, entry.schedule])).toEqual([
      ['obsidian', 'obsidian', 'healthy', { kind: 'watch', everyMinutes: null }],
      ['github', 'repo', 'healthy', { kind: 'interval', everyMinutes: 30 }],
      ['keep', 'keep', 'manual', { kind: 'manual', everyMinutes: null }],
      ['gdrive', 'gdrive', 'off', { kind: 'off', everyMinutes: null }],
    ])
    expect(source(status, 'github')).toMatchObject({ documents: 7, chunks: 21, lastSyncAt: null })
    expect(status.repos.map((entry) => [entry.name, entry.state, entry.documents])).toEqual([
      ['pythia', 'healthy', 5],
      ['notes', 'healthy', 2],
    ])
  })

  it('degrades a failing Gemini or devices lookup instead of failing', async () => {
    const { status } = await start({
      gemini: async () => {
        throw new Error('db down')
      },
      devices: async () => {
        throw new Error('db down')
      },
    })
    expect(await status()).toMatchObject({ gemini: { available: false }, devices: { active: 0 } })
  })

  it('shows the vault and repos as off when they are not configured', async () => {
    const { status, post } = await start({ vault: null, repos: null, rows: [row('keep', 'keep', 3, false)] })
    const result = await status()
    expect(source(result, 'obsidian')).toMatchObject({ state: 'off', schedule: { kind: 'off', everyMinutes: null } })
    expect(source(result, 'github')).toMatchObject({ state: 'off', schedule: { kind: 'off', everyMinutes: null } })
    expect(source(result, 'keep')).toMatchObject({ state: 'off', documents: 3 })
    expect(result.repos).toEqual([])
    const res = await post('/sync-now')
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ started: true, vault: 'off', repos: 'off', drive: 'off' })
  })

  it('shows a repo config that did not load as an error with a short reason', async () => {
    const { status } = await start({ repos: { names: [], intervalMs: 30 * 60_000, configError: 'repo config not loaded: SyntaxError' } })
    expect(source(await status(), 'github')).toMatchObject({ state: 'error', reason: 'repo config not loaded: SyntaxError' })
  })

  it('marks a repo whose fetch failed as error and keeps its old index and last sync time', async () => {
    const { status, activity } = await start()
    const recorder = createRepoActivity(activity, () => {})
    await recorder.round({ synced: [{ name: 'pythia' }, { name: 'notes' }], failed: [] })
    const firstRound = (await status()).sources[1]!.lastSyncAt
    recorder.failed('pythia', new FetchError('fatal: could not read from https://token@github.com/me/pythia'))
    await recorder.round({ synced: [{ name: 'notes' }], failed: [{ name: 'pythia' }] })
    const result = await status()
    expect(repo(result, 'pythia')).toMatchObject({ state: 'error', reason: 'fetch failed: FetchError', documents: 5, lastSyncAt: firstRound })
    expect(repo(result, 'notes').state).toBe('healthy')
    expect(source(result, 'github')).toMatchObject({ state: 'error', reason: '1 repo failed', documents: 7 })
    expect(JSON.stringify(result)).not.toContain('token@')
    // A later good fetch clears the error.
    await recorder.single('pythia', { synced: [{ name: 'pythia' }], failed: [] })
    expect(repo(await status(), 'pythia').state).toBe('healthy')
  })

  it('records blocked secrets as a count only, never the file or its text', async () => {
    const { status, store, activity } = await start()
    const vault = createVaultActivity(activity, () => {})
    await vault.scan(async () => {
      vault.logSecrets({ file: 'Private/aws-keys.md', droppedCount: 2 })
      return { indexed: ['Private/aws-keys.md'], unchanged: 0, deleted: [], failed: [] }
    })
    const result = await status()
    expect(result.activity.map((event) => [event.kind, event.source, event.count, event.message])).toEqual([
      ['secrets_blocked', 'obsidian', 2, null],
      ['vault_synced', 'obsidian', 1, null],
    ])
    expect(JSON.stringify(store.rows())).not.toContain('aws-keys')
    expect(JSON.stringify(result)).not.toContain('aws-keys')
    expect(source(result, 'obsidian')).toMatchObject({ state: 'healthy', lastSyncAt: new Date(clock - 1000).toISOString() })
  })

  it('shows a scheduled repo round as syncing, not only Sync now (T52)', async () => {
    let round: { running: boolean; repo: string | null } = { running: true, repo: 'notes' }
    const { status } = await start({ repoRound: () => round })
    const during = await status()
    expect(during.syncing).toBe(true)
    expect(source(during, 'github').syncing).toBe(true)
    expect(source(during, 'obsidian').syncing).toBe(false)
    expect(repo(during, 'notes').syncing).toBe(true)
    expect(repo(during, 'pythia').syncing).toBe(false)
    round = { running: false, repo: null }
    const after = await status()
    expect(after.syncing).toBe(false)
    expect(source(after, 'github').syncing).toBe(false)
    expect(after.repos.some((entry) => entry.syncing)).toBe(false)
  })

  it('shows a failed vault scan as error by error class only', async () => {
    const { status, activity } = await start()
    const vault = createVaultActivity(activity, () => {})
    await expect(
      vault.scan(async () => {
        throw new FetchError('EACCES: /home/me/vault/Private/diary.md')
      }),
    ).rejects.toThrow()
    const result = await status()
    expect(source(result, 'obsidian')).toMatchObject({ state: 'error', reason: 'scan failed: FetchError' })
    expect(JSON.stringify(result)).not.toContain('diary')
  })

  it('forwards warning and broken health values from the health service', async () => {
    let currentHealth: 'ok' | 'warning' | 'broken' = 'warning'
    const { status } = await start({ health: async () => currentHealth })
    expect((await status()).health).toBe('warning')
    currentHealth = 'broken'
    expect((await status()).health).toBe('broken')
  })
})

describe('GET /api/activity', () => {
  it('keeps the last 50 events, newest first, and is never cached', async () => {
    const { get, activity } = await start()
    for (let i = 1; i <= MAX_ACTIVITY + 5; i += 1) await activity.record({ kind: 'repo_fetched', source: 'pythia', count: i })
    const res = await get('/activity')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { activity: StatusJson['activity'] }
    expect(body.activity).toHaveLength(MAX_ACTIVITY)
    expect(body.activity[0]).toMatchObject({ kind: 'repo_fetched', source: 'pythia', count: MAX_ACTIVITY + 5, message: null })
    expect(body.activity.at(-1)?.count).toBe(6)
    expect(typeof body.activity[0]?.at).toBe('string')
  })
})

describe('POST /api/sync-now', () => {
  it('answers 202 at once and never starts a second run when pressed twice quickly', async () => {
    const wait = gate()
    const runs = { vault: 0, repos: 0 }
    const { post, status, sync } = await start({
      sync: {
        vault: async () => {
          runs.vault += 1
          await wait.promise
        },
        repos: async () => {
          runs.repos += 1
          await wait.promise
        },
      },
    })
    const [first, second] = await Promise.all([post('/sync-now'), post('/sync-now')])
    expect([first.status, second.status]).toEqual([202, 202])
    expect(first.headers.get('cache-control')).toBe('no-store')
    const bodies = [await first.json(), await second.json()]
    expect(bodies).toEqual(
      expect.arrayContaining([
        { started: true, vault: 'started', repos: 'started', drive: 'off' },
        { started: false, vault: 'running', repos: 'running', drive: 'off' },
      ]),
    )
    expect(runs).toEqual({ vault: 1, repos: 1 })
    const during = await status()
    expect(during.syncing).toBe(true)
    expect(source(during, 'obsidian').syncing).toBe(true)
    expect(repo(during, 'pythia').syncing).toBe(true)
    wait.open()
    await sync.idle()
    expect((await status()).syncing).toBe(false)
  })

  it('runs the repos alone when the vault is off', async () => {
    const runs = { repos: 0 }
    const { post, sync } = await start({
      vault: null,
      sync: {
        repos: async () => {
          runs.repos += 1
        },
      },
    })
    const res = await post('/sync-now')
    expect(await res.json()).toEqual({ started: true, vault: 'off', repos: 'started', drive: 'off' })
    await sync.idle()
    expect(runs.repos).toBe(1)
  })
})

describe('POST /api/repos/:name/sync', () => {
  const names = ['pythia', 'notes']

  it('starts one repo fetch with 202 and reports a second press as running', async () => {
    const wait = gate()
    const { post, status, sync } = await start({
      sync: { repo: (name) => (names.includes(name) ? wait.promise : null) },
    })
    const res = await post('/repos/pythia/sync')
    expect(res.status).toBe(202)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ name: 'pythia', started: true, state: 'started' })
    const again = await post('/repos/pythia/sync')
    expect(again.status).toBe(202)
    expect(await again.json()).toEqual({ name: 'pythia', started: false, state: 'running' })
    const result = await status()
    expect(repo(result, 'pythia').syncing).toBe(true)
    expect(repo(result, 'notes').syncing).toBe(false)
    expect(source(result, 'github').syncing).toBe(true)
    wait.open()
    await sync.idle()
    expect(repo(await status(), 'pythia').syncing).toBe(false)
  })

  it('answers 404 for a repo not in the config', async () => {
    const { post } = await start({ sync: { repo: (name) => (names.includes(name) ? Promise.resolve() : null) } })
    const res = await post('/repos/missing/sync')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('answers 409 when repo fetching is off', async () => {
    const { post } = await start({ repos: null })
    const res = await post('/repos/pythia/sync')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'repos_off' } })
  })

  it('rejects an empty name with 400', async () => {
    const { post } = await start({ sync: { repo: () => Promise.resolve() } })
    const res = await post('/repos/%20/sync')
    expect(res.status).toBe(400)
  })
})

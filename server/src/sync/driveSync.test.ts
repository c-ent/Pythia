import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChunkWrite, DocumentState, DocumentWrite, IndexStore } from '../db/indexStore.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { OfficeConverter } from '../ingest/driveConvert.js'
import { DRIVE_CONVERTED_EXTENSIONS } from '../ingest/driveConvert.js'
import { DRIVE_DOCUMENT_EXTENSIONS } from '../ingest/driveExtract.js'
import { createDriveIndexer } from '../ingest/driveIndexer.js'
import {
  createRcloneRunner,
  DRIVE_DOCUMENT_FILTER,
  DRIVE_PULL_FILTERS,
  DriveLoginError,
  DrivePullError,
  rcloneArgs,
  type RcloneRunner,
} from '../ingest/driveMirror.js'
import { startDriveScheduler } from '../ingest/driveScheduler.js'
import { createDriveRound } from '../ingest/startDrive.js'
import {
  createActivityLog,
  createDriveActivity,
  createMemoryActivityStore,
  DRIVE_LOGIN_REASON,
  DRIVE_SOURCE,
} from './activity.js'
import { createStatusService } from './statusService.js'
import { createSyncNow } from './syncNow.js'

// T61: the Drive round (exclude list, rclone pull, index), its schedule, Sync
// now, status and activity, with a stubbed rclone runner.

// Built at runtime so no literal secret is ever committed.
const FAKE_TOKEN = 'ya29.' + 'Q7w9E2r4T6y8'.repeat(4)
const FAKE_REFRESH = '1//' + 'Zx8Cv6Bn4Mm2'.repeat(3)

function memoryStore() {
  const docs = new Map<string, { doc: DocumentWrite; chunks: ChunkWrite[]; embedModel: string }>()
  const store: IndexStore = {
    async getDocumentStates(_sourceId, embedModel, paths) {
      const states = new Map<string, DocumentState>()
      for (const stored of docs.values()) {
        if (paths !== undefined && !paths.includes(stored.doc.path)) continue
        states.set(stored.doc.path, {
          contentHash: stored.doc.contentHash,
          allowLlm: stored.doc.allowLlm,
          stale: stored.chunks.length > 0 && stored.embedModel !== embedModel,
        })
      }
      return states
    },
    async replaceDocument(_sourceId, doc, chunks, embedModel) {
      docs.set(doc.path, { doc: { ...doc }, chunks: [...chunks], embedModel })
    },
    async replaceLinks() {},
    async setAllowLlm(_sourceId, relPath, allowLlm) {
      const stored = docs.get(relPath)
      if (stored) stored.doc.allowLlm = allowLlm
    },
    async deleteDocuments(_sourceId, paths) {
      let n = 0
      for (const relPath of paths) if (docs.delete(relPath)) n++
      return n
    },
  }
  return { store, docs }
}

const embedder: Embedder = {
  model: 'nomic-embed-text',
  dimensions: EMBED_DIMENSIONS,
  async embedDocuments(texts) {
    return texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, () => 0.1))
  },
  async embedQuery() {
    return Array.from({ length: EMBED_DIMENSIONS }, () => 0)
  },
}

const converter: OfficeConverter = () => Promise.reject(new Error('no LibreOffice in this test'))

let root: string
let configDir: string

const put = async (relPath: string, text: string): Promise<void> => {
  const abs = path.join(root, ...relPath.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, text)
}

/** Stands in for rclone: records the arguments and either "pulls" (writes the Drive files) or fails. */
function fakeRclone() {
  const calls: string[][] = []
  const state = { fail: null as Error | null, gate: null as Promise<void> | null }
  const run: RcloneRunner = async (args) => {
    calls.push([...args])
    if (state.gate !== null) await state.gate
    if (state.fail !== null) throw state.fail
    await put('Notes/todo.md', '# Todo\n\nCall the bank.')
    await put('Work/plan.md', '# Plan\n\nQ3 targets.')
    return { duplicates: 0 }
  }
  return { run, calls, state }
}

function setup(options: { exclude?: string[] | null } = {}) {
  let clock = Date.UTC(2026, 10, 27)
  const mem = memoryStore()
  const activity = createActivityLog(createMemoryActivityStore(), { now: () => (clock += 1000) })
  const recorder = createDriveActivity(activity, () => {})
  const indexer = createDriveIndexer({
    root,
    sourceId: 1,
    store: mem.store,
    embedder,
    converter,
    logSecrets: recorder.logSecrets,
  })
  const rclone = fakeRclone()
  const configFile = options.exclude === null ? null : path.join(configDir, 'gdrive.json')
  const writeExclude = (exclude: string[]) => writeFile(path.join(configDir, 'gdrive.json'), JSON.stringify({ exclude }))
  const round = createDriveRound({
    drive: { remote: 'gdrive:', configFile, rcloneConfig: '/config/rclone/rclone.conf' },
    root,
    rclone: rclone.run,
    indexer,
    recorder,
    log: () => {},
  })
  return { mem, activity, rclone, round, writeExclude }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pythia-drive-sync-'))
  configDir = await mkdtemp(path.join(tmpdir(), 'pythia-drive-config-'))
  await writeFile(path.join(configDir, 'gdrive.json'), JSON.stringify({ exclude: [] }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  await rm(configDir, { recursive: true, force: true })
})

describe('Drive round (T61)', () => {
  it('pulls My Drive only with the exclude list, then indexes the mirror', async () => {
    const { rclone, round, writeExclude, mem } = setup()
    await writeExclude(['Clients/Acme Corp', 'Archive [old]'])
    const result = await round()
    expect(result.indexed).toEqual(['Notes/todo.md', 'Work/plan.md'])
    expect(mem.docs.size).toBe(2)
    const args = rclone.calls[0]!
    expect(args.slice(0, 3)).toEqual(['sync', 'gdrive:', root])
    expect(args).toEqual(expect.arrayContaining(['--drive-scope', 'drive.readonly', '--drive-skip-shortcuts']))
    expect(args.join(' ')).not.toMatch(/shared-with-me|team-drive|shared-drive/)
    const filters = args.flatMap((arg, i) => (args[i - 1] === '--filter' ? [arg] : []))
    expect(filters).toEqual(['- /Archive \\[old\\]/**', '- /Clients/Acme Corp/**', ...DRIVE_PULL_FILTERS])
    expect(args).toContain('--delete-excluded')
  })

  it('removes an already indexed folder once it is on the exclude list', async () => {
    const { round, writeExclude, mem } = setup()
    await round()
    expect(mem.docs.has('Work/plan.md')).toBe(true)
    await writeExclude(['Work'])
    const result = await round()
    expect(result.deleted).toEqual(['Work/plan.md'])
    expect([...mem.docs.keys()]).toEqual(['Notes/todo.md'])
  })

  it('keeps the index and sets error when the pull fails, and recovers on the next round', async () => {
    const { activity, rclone, round, mem } = setup()
    await round()
    rclone.state.fail = new DrivePullError('rclone exited with code 1')
    await expect(round()).rejects.toThrow(DrivePullError)
    expect(mem.docs.size).toBe(2)
    const status = createStatusService({
      sources: { listSources: async () => [] },
      activity,
      vault: null,
      repos: null,
      drive: { intervalMs: 30 * 60_000 },
      log: () => {},
    })
    const failed = (await status.status()).sources.find((source) => source.id === DRIVE_SOURCE)!
    expect(failed).toMatchObject({ kind: 'gdrive', state: 'error', reason: 'Drive round failed: DrivePullError' })
    expect(failed.schedule).toEqual({ kind: 'interval', everyMinutes: 30 })
    expect(failed.lastSyncAt).not.toBeNull()
    rclone.state.fail = null
    await round()
    expect((await status.status()).sources.find((source) => source.id === DRIVE_SOURCE)!.state).toBe('healthy')
  })

  it('says the Drive login must be renewed when it expired', async () => {
    const { activity, rclone, round } = setup()
    rclone.state.fail = new DriveLoginError('The Drive login must be renewed on the host')
    await expect(round()).rejects.toThrow(DriveLoginError)
    const [event] = await activity.list()
    expect(event).toMatchObject({ kind: 'sync_error', source: DRIVE_SOURCE, message: DRIVE_LOGIN_REASON })
  })

  it('does not pull when the config file is broken, so excluded folders never come in', async () => {
    const { rclone, round, activity } = setup()
    await writeFile(path.join(configDir, 'gdrive.json'), '{ "exclude": ["Work"], "typo": 1 }')
    await expect(round()).rejects.toThrow(/Drive config file/)
    expect(rclone.calls).toEqual([])
    expect((await activity.list())[0]).toMatchObject({ kind: 'sync_error', message: 'Drive round failed: DriveConfigError' })
  })

  it('runs with no exclude file configured and still restricts pulls to document formats', async () => {
    const { rclone, round } = setup({ exclude: null })
    await round()
    const filters = rclone.calls[0]!.flatMap((arg, i, all) => (all[i - 1] === '--filter' ? [arg] : []))
    expect(filters).toEqual([...DRIVE_PULL_FILTERS])
    expect(rcloneArgs({ remote: 'gdrive:', dest: '/data/gdrive', exclude: [] })).toContain(DRIVE_DOCUMENT_FILTER)
    for (const ext of [...DRIVE_DOCUMENT_EXTENSIONS, ...DRIVE_CONVERTED_EXTENSIONS]) {
      expect(DRIVE_DOCUMENT_FILTER).toContain(ext.slice(1))
    }
  })

  it('records a drive_pulled event with counts only', async () => {
    const { activity, round } = setup()
    await put('Photos/cat.png', '\u0089PNG')
    await round()
    const [event] = await activity.list()
    expect(event).toMatchObject({ kind: 'drive_pulled', source: DRIVE_SOURCE, count: 2, message: '1 skipped' })
  })
})

describe('Drive schedule and Sync now (T61)', () => {
  it('runs at startup and never runs twice when Sync now is pressed during a round', async () => {
    const { rclone, round } = setup()
    let open!: () => void
    rclone.state.gate = new Promise<void>((resolve) => (open = resolve))
    const scheduler = startDriveScheduler({ round, intervalMs: 60_000, log: () => {} })
    const sync = createSyncNow({ drive: () => scheduler.runNow(), log: () => {} })
    const status = createStatusService({
      sources: { listSources: async () => [] },
      activity: createActivityLog(createMemoryActivityStore()),
      vault: null,
      repos: null,
      drive: { intervalMs: 60_000 },
      syncing: () => sync.state(),
      driveRound: () => scheduler.state(),
      log: () => {},
    })
    await vi.waitFor(() => expect(rclone.calls).toHaveLength(1), { timeout: 5000 })
    expect((await status.status()).syncing).toBe(true)
    expect((await status.status()).sources.find((source) => source.id === DRIVE_SOURCE)!.syncing).toBe(true)
    expect(sync.syncNow()).toEqual({ started: true, vault: 'off', repos: 'off', drive: 'started' })
    expect(sync.syncNow()).toEqual({ started: false, vault: 'off', repos: 'off', drive: 'running' })
    open()
    await sync.idle()
    expect(rclone.calls).toHaveLength(1)
    expect((await status.status()).syncing).toBe(false)
    rclone.state.gate = null
    await scheduler.runNow()
    expect(rclone.calls).toHaveLength(2)
    await scheduler.close()
  })

  it('keeps the schedule after a failed round', async () => {
    vi.useFakeTimers()
    try {
      const calls: number[] = []
      const failed: string[] = []
      const scheduler = startDriveScheduler({
        round: async () => {
          calls.push(Date.now())
          throw new DrivePullError('network down')
        },
        intervalMs: 1_000,
        onFailed: (error) => failed.push((error as Error).name),
        log: () => {},
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toHaveLength(2)
      expect(failed).toEqual(['DrivePullError', 'DrivePullError'])
      await scheduler.close()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('rclone runner logs (T61)', () => {
  /** A stand-in rclone: a node script that prints to stderr and exits with `code`. */
  const scriptRunner = (stderr: string, code: number) =>
    createRcloneRunner({
      command: process.execPath,
      prefixArgs: ['-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code})`, '--'],
      env: process.env,
    })

  const captureConsole = () => {
    const lines: string[] = []
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
      })
    }
    return lines
  }

  it('never puts a token or rclone config content in an error or a log line', async () => {
    const lines = captureConsole()
    const stderr =
      `ERROR : Failed to create file system: couldn't fetch token: invalid_grant\n` +
      `[gdrive]\ntoken = {"access_token":"${FAKE_TOKEN}","refresh_token":"${FAKE_REFRESH}"}\n`
    const { round, activity } = setup()
    const failing = createDriveRound({
      drive: { remote: 'gdrive:', configFile: null, rcloneConfig: null },
      root,
      rclone: scriptRunner(stderr, 1),
      indexer: createDriveIndexer({ root, sourceId: 1, store: memoryStore().store, embedder, converter }),
      recorder: createDriveActivity(activity, () => {}),
    })
    void round
    const scheduler = startDriveScheduler({
      round: failing,
      intervalMs: 60_000,
      onFailed: (error) => console.error(`drive round failed: ${(error as Error).name}; index kept`),
    })
    const error = await scheduler.runNow().catch((caught: unknown) => caught)
    await scheduler.close()
    expect(error).toBeInstanceOf(DriveLoginError)
    const everything = [String((error as Error).message), ...lines, JSON.stringify(await activity.list())].join('\n')
    expect(everything).toContain(DRIVE_LOGIN_REASON)
    for (const secret of [FAKE_TOKEN, FAKE_REFRESH, 'access_token', 'refresh_token', '[gdrive]']) {
      expect(everything).not.toContain(secret)
    }
  })

  it('counts duplicate names and resolves on success', async () => {
    const run = scriptRunner('NOTICE: Report.docx: Duplicate object found in source - ignoring\n', 0)
    expect(await run(['sync'])).toEqual({ duplicates: 1 })
  })

  it('fails a non-login error as a pull error', async () => {
    const run = scriptRunner('ERROR : dial tcp: lookup www.googleapis.com: no such host\n', 3)
    await expect(run(['sync'])).rejects.toThrow(DrivePullError)
  })
})

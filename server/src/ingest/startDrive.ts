import path from 'node:path'
import type { Pool } from 'pg'
import type { DriveConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { createDriveActivity, type ActivityLog, type DriveActivity } from '../sync/activity.js'
import { loadDriveConfigFile } from './driveConfig.js'
import { createSofficeConverter, type OfficeConverter } from './driveConvert.js'
import { createDriveIndexer, type DriveIndexer, type DriveIndexResult } from './driveIndexer.js'
import { createRcloneRunner, pullDrive, type RcloneRunner } from './driveMirror.js'
import type { LlmExclusionStore } from './llmExclusions.js'
import { startDriveScheduler, type DriveScheduler } from './driveScheduler.js'

export interface RunningDrive {
  /** Pull and index on demand (Sync now); absent when the source is switched off. */
  runNow?: () => Promise<DriveIndexResult>
  /** A round is running (startup, every 30 minutes or Sync now); absent when off. */
  state?: () => { running: boolean }
  /** Live progress during a round, or null when idle. */
  progress?: () => { stage: string; done: number | null; total: number | null } | null
  /** Time between rounds, in ms. */
  intervalMs: number
  close(): Promise<void>
}

export interface StartDriveOptions {
  /** Injected in tests; rclone on PATH by default. */
  rclone?: RcloneRunner
  /** Injected in tests; LibreOffice headless by default. */
  converter?: OfficeConverter
  /** The Gemini list; its Drive rules are applied every round (T62). */
  exclusions?: Pick<LlmExclusionStore, 'list'>
}

export const summarizeDriveRound = (result: DriveIndexResult) => ({
  files: result.files,
  indexed: result.indexed.length,
  unchanged: result.unchanged,
  deleted: result.deleted.length,
  failed: result.failed.length,
  skipped: result.skipped,
  keptEmptyMirror: result.keptEmptyMirror === true,
})

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

export interface DriveRoundOptions {
  drive: Pick<DriveConfig, 'remote' | 'configFile' | 'rcloneConfig'>
  /** Absolute path of the mirror. */
  root: string
  rclone: RcloneRunner
  indexer: DriveIndexer
  recorder: DriveActivity
  /** Counts only. */
  log?: (message: string) => void
  /** Called when the pull stage starts/ends so status can report 'pulling'. */
  onPulling?: (pulling: boolean) => void
}

/**
 * One Drive round: read the exclude list, pull, index, record the activity.
 * A bad config file stops the round before the pull (pulling without the
 * exclude list could bring excluded work folders in); a failed pull stops it
 * before the indexer, so the index is kept as it is.
 */
export function createDriveRound(options: DriveRoundOptions): () => Promise<DriveIndexResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  return () =>
    options.recorder.round(async () => {
      // Read every round, so an edit on the host applies without a restart.
      const { exclude } = await loadDriveConfigFile(options.drive.configFile)
      options.onPulling?.(true)
      let pulled: Awaited<ReturnType<typeof pullDrive>>
      try {
        pulled = await pullDrive(
          {
            remote: options.drive.remote,
            dest: options.root,
            exclude,
            rcloneConfig: options.drive.rcloneConfig,
          },
          options.rclone,
        )
      } finally {
        options.onPulling?.(false)
      }
      if (pulled.duplicates > 0) log(`drive pull: ${pulled.duplicates} duplicate names, one kept each`)
      return options.indexer.fullScan({ exclude })
    })
}

/**
 * Registers the `gdrive` source and starts the Drive rounds (R19, T61) at
 * startup, every 30 minutes and on Sync now. A failed pull or a bad config
 * file keeps the index and is retried next round; it is never fatal. Logs and
 * activity events carry counts and error classes only, never file names,
 * tokens or rclone output.
 */
export async function startDrive(
  pool: Pool,
  drive: DriveConfig,
  embedder: Embedder,
  activity?: ActivityLog,
  options: StartDriveOptions = {},
): Promise<RunningDrive> {
  const root = path.resolve(drive.mirrorDir)
  const source = await ensureSource(pool, 'gdrive', 'gdrive', root)
  if (!source.enabled) {
    console.log('drive source is disabled; not pulling')
    return { intervalMs: drive.pullIntervalMs, close: async () => {} }
  }
  console.log(`drive: pull every ${Math.round(drive.pullIntervalMs / 60_000)} min`)
  const recorder = createDriveActivity(activity)
  const exclusionStore = options.exclusions
  const indexer = createDriveIndexer({
    root,
    sourceId: source.id,
    store: createPgIndexStore(pool),
    embedder,
    converter: options.converter ?? createSofficeConverter(),
    logSecrets: recorder.logSecrets,
    ...(exclusionStore === undefined ? {} : { exclusions: () => exclusionStore.list() }),
  })

  let pulling = false
  const scheduler: DriveScheduler = startDriveScheduler({
    intervalMs: drive.pullIntervalMs,
    round: createDriveRound({
      drive,
      root,
      rclone: options.rclone ?? createRcloneRunner(),
      indexer,
      recorder,
      onPulling: (active) => {
        pulling = active
      },
    }),
    onRound: (result) => console.log('drive round', summarizeDriveRound(result)),
    onFailed: (error) => console.error(`drive round failed: ${errorName(error)}; index kept`),
  })

  return {
    runNow: () => scheduler.runNow(),
    state: () => scheduler.state(),
    progress: () => (pulling ? { stage: 'pulling', done: null, total: null } : (indexer.progress?.() ?? null)),
    intervalMs: drive.pullIntervalMs,
    close: () => scheduler.close(),
  }
}

import type { SourceRow } from '../db/indexStore.js'
import type { IndexStore } from '../db/indexStore.js'
import type { SourceStatusRow, StatusStore } from '../db/statusStore.js'
import type { Embedder } from '../embed/ollama.js'
import { createKeepImporter, type KeepImporter, type KeepImportResult } from './keepImporter.js'
import { KeepTakeoutError, parseKeepTakeout } from './keepTakeout.js'
import type { LlmExclusion } from './llmExclusions.js'
import {
  createSecretsTally,
  KEEP_SOURCE,
  recordAll,
  secretsEvents,
  syncErrorEvent,
  type ActivityLog,
} from '../sync/activity.js'

/** `off` when the source is not configured on this server. */
export type ReindexState = 'off' | 'idle' | 'running'

export interface IndexStatus {
  sources: SourceStatusRow[]
  reindex: { vault: ReindexState; repos: ReindexState }
}

/** The Keep source exists but the owner switched it off (`sources.enabled = false`). */
export class KeepDisabledError extends Error {
  override name = 'KeepDisabledError'
}

export interface ImportService {
  /**
   * Replaces all Keep documents with the notes in a Takeout zip (R12).
   * Throws `KeepTakeoutError` before anything is written when the zip is not
   * a Keep export, so a wrong upload never wipes the existing notes.
   */
  importKeep(zip: Uint8Array): Promise<KeepImportResult>
  status(): Promise<IndexStatus>
  /**
   * Starts a vault rescan and a repo fetch round in the background and
   * returns at once. A rescan skips unchanged files, so it catches up on
   * changes rather than re-embedding everything.
   */
  reindex(): IndexStatus['reindex']
}

export interface ImportServiceOptions {
  status: StatusStore
  /** Finds or creates the Keep source row. */
  keepSource: () => Promise<SourceRow>
  store: IndexStore
  embedder: Embedder
  /** The Gemini list (R16); a `keep` rule locks every Keep note. Absent means empty. */
  exclusions?: () => Promise<readonly LlmExclusion[]>
  /** Full vault scan and repo fetch round; absent when that source is not configured. */
  reindexers?: { vault?: () => Promise<unknown>; repos?: () => Promise<unknown> }
  /** Counts and kinds only, never note text. */
  log?: (message: string, details?: unknown) => void
  /** Records `keep_imported`, blocked-secret counts and failures (R18); absent records nothing. */
  activity?: ActivityLog
}

export function createImportService(options: ImportServiceOptions): ImportService {
  const log = options.log ?? ((message: string, details?: unknown) => console.log(message, details ?? ''))
  const importers = new Map<number, KeepImporter>()
  const running = { vault: false, repos: false }
  const secrets = createSecretsTally()

  const stateOf = (name: 'vault' | 'repos'): ReindexState =>
    options.reindexers?.[name] === undefined ? 'off' : running[name] ? 'running' : 'idle'
  const reindexState = (): IndexStatus['reindex'] => ({ vault: stateOf('vault'), repos: stateOf('repos') })

  function start(name: 'vault' | 'repos'): void {
    const task = options.reindexers?.[name]
    if (task === undefined || running[name]) return
    running[name] = true
    void task()
      .then(() => log(`manual reindex: ${name} done`))
      .catch((error: unknown) => log(`manual reindex: ${name} failed`, error instanceof Error ? error.name : 'unknown'))
      .finally(() => {
        running[name] = false
      })
  }

  return {
    async importKeep(zip) {
      // Parse first: a bad upload must fail before the source is touched.
      const takeout = parseKeepTakeout(zip)
      if (takeout.notes.length === 0) {
        throw new KeepTakeoutError('This Keep export has no notes to import (all are trashed or empty)')
      }
      const source = await options.keepSource()
      if (!source.enabled) throw new KeepDisabledError('Keep import is switched off for this server')
      let importer = importers.get(source.id)
      if (importer === undefined) {
        importer = createKeepImporter({
          sourceId: source.id,
          store: options.store,
          embedder: options.embedder,
          ...(options.exclusions === undefined ? {} : { exclusions: options.exclusions }),
          logSecrets: secrets.logger,
        })
        importers.set(source.id, importer)
      }
      let result: KeepImportResult
      try {
        result = await importer.importNotes(takeout)
      } catch (error) {
        await recordAll(options.activity, [...secretsEvents(KEEP_SOURCE, secrets), syncErrorEvent(KEEP_SOURCE, 'import failed', error)])
        throw error
      }
      await recordAll(options.activity, [
        {
          kind: 'keep_imported',
          source: KEEP_SOURCE,
          count: result.notes,
          message: result.failed > 0 ? `${result.failed} failed` : null,
        },
        ...secretsEvents(KEEP_SOURCE, secrets),
      ])
      log('keep import', {
        notes: result.notes,
        indexed: result.indexed,
        unchanged: result.unchanged,
        deleted: result.deleted,
        failed: result.failed,
        skipped: result.skipped,
      })
      return result
    },

    async status() {
      return { sources: await options.status.listSources(), reindex: reindexState() }
    },

    reindex() {
      start('vault')
      start('repos')
      return reindexState()
    },
  }
}

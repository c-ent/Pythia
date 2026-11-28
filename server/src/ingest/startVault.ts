import type { Pool } from 'pg'
import type { VaultConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import { createVaultActivity, type ActivityLog } from '../sync/activity.js'
import type { LlmExclusionStore } from './llmExclusions.js'
import type { Embedder } from '../embed/ollama.js'
import { createVaultIndexer, type IndexResult } from './vaultIndexer.js'
import { watchVault, type VaultWatcher } from './vaultWatcher.js'

const summarize = (result: IndexResult) => ({
  indexed: result.indexed.length,
  unchanged: result.unchanged,
  deleted: result.deleted.length,
  failed: result.failed.map((failure) => failure.path),
  keptEmptyVault: result.keptEmptyVault === true,
})

export interface RunningVault {
  /** Full scan on demand (Import page re-index, Sync now); absent when the source is disabled. */
  rescan?: () => Promise<void>
  /** Re-applies the Gemini exclusion list without embedding; absent when the source is disabled. */
  refreshAllowLlm?: () => Promise<void>
  /** Live progress during a full scan, or null when idle. */
  progress?: () => { stage: string; done: number | null; total: number | null } | null
  /** Whether the watcher runs (PYTHIA_VAULT_WATCH). */
  watching: boolean
  close(): Promise<void>
}

/**
 * Registers the vault source, runs a full scan in the background and starts
 * the watcher. A scan failure is logged, never fatal: search keeps serving
 * the existing index. Logs carry counts and paths, never note text; activity
 * events (R18) carry counts and an error class only.
 */
export async function startVault(
  pool: Pool,
  vault: VaultConfig,
  embedder: Embedder,
  exclusions: LlmExclusionStore,
  activity?: ActivityLog,
): Promise<RunningVault> {
  const source = await ensureSource(pool, 'obsidian', 'vault', vault.root)
  if (!source.enabled) {
    console.log('vault source is disabled; not indexing')
    return { watching: false, close: async () => {} }
  }
  const recorder = createVaultActivity(activity)
  const indexer = createVaultIndexer({
    root: vault.root,
    sourceId: source.id,
    store: createPgIndexStore(pool),
    embedder,
    exclusions: () => exclusions.list(),
    logSecrets: recorder.logSecrets,
  })

  const scan = recorder
    .scan(() => indexer.fullScan())
    .then((result) => console.log('vault full scan', summarize(result)))
    .catch((error: unknown) => console.error('vault full scan failed', error instanceof Error ? error.message : error))

  let watcher: VaultWatcher | undefined
  if (vault.watch) {
    watcher = watchVault({
      root: vault.root,
      indexer,
      onResult(result) {
        if (result.indexed.length + result.deleted.length + result.failed.length > 0 || result.keptEmptyVault === true) {
          console.log('vault sync', summarize(result))
        }
        void recorder.batch(result)
      },
      onError(error) {
        console.error('vault watcher error', error instanceof Error ? error.message : String(error))
        void recorder.batchError(error)
      },
    })
  }

  return {
    async rescan() {
      console.log('vault full scan', summarize(await recorder.scan(() => indexer.fullScan())))
    },
    async refreshAllowLlm() {
      console.log('vault allow_llm refresh', await indexer.refreshAllowLlm())
    },
    progress: () => indexer.progress?.() ?? null,
    watching: vault.watch,
    async close() {
      await watcher?.close()
      await scan
    },
  }
}

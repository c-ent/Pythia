import type { Pool } from 'pg'
import type { VaultConfig } from '../config.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
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
  /** Full scan on demand (Import page re-index); absent when the source is disabled. */
  rescan?: () => Promise<void>
  /** Re-applies the Gemini exclusion list without embedding; absent when the source is disabled. */
  refreshAllowLlm?: () => Promise<void>
  close(): Promise<void>
}

/**
 * Registers the vault source, runs a full scan in the background and starts
 * the watcher. A scan failure is logged, never fatal: search keeps serving
 * the existing index. Logs carry counts and paths, never note text.
 */
export async function startVault(
  pool: Pool,
  vault: VaultConfig,
  embedder: Embedder,
  exclusions: LlmExclusionStore,
): Promise<RunningVault> {
  const source = await ensureSource(pool, 'obsidian', 'vault', vault.root)
  if (!source.enabled) {
    console.log('vault source is disabled; not indexing')
    return { close: async () => {} }
  }
  const indexer = createVaultIndexer({
    root: vault.root,
    sourceId: source.id,
    store: createPgIndexStore(pool),
    embedder,
    exclusions: () => exclusions.list(),
  })

  const scan = indexer
    .fullScan()
    .then((result) => console.log('vault full scan', summarize(result)))
    .catch((error: unknown) => console.error('vault full scan failed', error instanceof Error ? error.message : error))

  let watcher: VaultWatcher | undefined
  if (vault.watch) watcher = watchVault({ root: vault.root, indexer })

  return {
    async rescan() {
      console.log('vault full scan', summarize(await indexer.fullScan()))
    },
    async refreshAllowLlm() {
      console.log('vault allow_llm refresh', await indexer.refreshAllowLlm())
    },
    async close() {
      await watcher?.close()
      await scan
    },
  }
}

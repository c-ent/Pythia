import { watch, type FSWatcher } from 'chokidar'
import type { IndexResult, VaultIndexer } from './vaultIndexer.js'
import { toVaultPath } from './vaultIndexer.js'

export const DEFAULT_DEBOUNCE_MS = 1500

export interface DebouncedBatcher {
  add(item: string): void
  /** Runs any pending batch now and resolves when it and every earlier batch have finished. */
  flush(): Promise<void>
  cancel(): void
}

/**
 * Collects items and hands them to `run` once no new item has arrived for
 * `delayMs`. Obsidian saves a note many times while typing; this turns a
 * burst of saves into one re-index. Batches never overlap.
 */
export function createDebouncedBatcher(
  run: (items: string[]) => Promise<void>,
  delayMs: number,
): DebouncedBatcher {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()

  const fire = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (pending.size === 0) return running
    const items = [...pending]
    pending = new Set()
    running = running.then(() => run(items))
    return running
  }

  return {
    add(item) {
      pending.add(item)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void fire(), delayMs)
    },
    flush: fire,
    cancel() {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = new Set()
    },
  }
}

export interface VaultWatcherOptions {
  root: string
  indexer: VaultIndexer
  debounceMs?: number
  /** Called after every batch, for logging. Never receives note text. */
  onResult?: (result: IndexResult) => void
  onError?: (error: unknown) => void
}

export interface VaultWatcher {
  /** Resolves once chokidar has finished its initial walk of the vault. */
  ready: Promise<void>
  /** Runs any pending batch now. */
  flush(): Promise<void>
  close(): Promise<void>
}

// A folder delete or rename can arrive as one `unlinkDir` with no event per
// file, so it is queued as this marker and answered with a full scan.
const RESCAN = '\u0000rescan'

const defaultOnResult = (result: IndexResult): void => {
  const changed = result.indexed.length + result.deleted.length + result.failed.length
  if (changed === 0 && result.keptEmptyVault !== true) return
  console.log('vault sync', {
    indexed: result.indexed.length,
    unchanged: result.unchanged,
    deleted: result.deleted.length,
    failed: result.failed.map((failure) => failure.path),
    keptEmptyVault: result.keptEmptyVault === true,
  })
}

const defaultOnError = (error: unknown): void => {
  console.error('vault watcher error', error instanceof Error ? error.message : String(error))
}

/**
 * Watches the vault read-only and re-indexes changed notes after a quiet
 * period. Does not index on start; run `indexer.fullScan()` for that.
 */
export function watchVault(options: VaultWatcherOptions): VaultWatcher {
  const { root, indexer } = options
  const onResult = options.onResult ?? defaultOnResult
  const onError = options.onError ?? defaultOnError

  const batcher = createDebouncedBatcher(async (items) => {
    try {
      const result = items.includes(RESCAN) ? await indexer.fullScan() : await indexer.syncPaths(items)
      onResult(result)
    } catch (error) {
      onError(error)
    }
  }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)

  const watcher: FSWatcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    // Skip dot folders (.obsidian, .trash, .git) entirely; non-Markdown files
    // are filtered by the indexer, which also applies the secrets blocklist.
    ignored: (absPath: string) => {
      const rel = toVaultPath(root, absPath)
      return rel === null || (rel !== '' && rel.split('/').some((segment) => segment.startsWith('.')))
    },
  })

  const queuePath = (absPath: string): void => {
    const rel = toVaultPath(root, absPath)
    if (rel !== null && rel !== '') batcher.add(rel)
  }
  watcher.on('add', queuePath)
  watcher.on('change', queuePath)
  watcher.on('unlink', queuePath)
  watcher.on('unlinkDir', () => batcher.add(RESCAN))
  watcher.on('error', onError)

  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()))

  return {
    ready,
    flush: () => batcher.flush(),
    async close() {
      await watcher.close()
      // Finish what was already queued so a shutdown does not lose a save.
      await batcher.flush()
    },
  }
}

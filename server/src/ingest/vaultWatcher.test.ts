import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexResult, VaultIndexer } from './vaultIndexer.js'
import { createDebouncedBatcher, watchVault, type VaultWatcher } from './vaultWatcher.js'

describe('createDebouncedBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a burst of saves into one batch after the quiet period', async () => {
    const run = vi.fn(async () => {})
    const batcher = createDebouncedBatcher(run, 1000)
    batcher.add('a.md')
    await vi.advanceTimersByTimeAsync(600)
    batcher.add('a.md')
    batcher.add('b.md')
    await vi.advanceTimersByTimeAsync(600)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['a.md', 'b.md'])
  })

  it('flush runs the pending batch at once and waits for it', async () => {
    let finished = false
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      finished = true
    })
    const batcher = createDebouncedBatcher(run, 10_000)
    batcher.add('a.md')
    const flushed = batcher.flush()
    await vi.advanceTimersByTimeAsync(50)
    await flushed
    expect(finished).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    await batcher.flush()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never runs two batches at once', async () => {
    let active = 0
    let maxActive = 0
    const run = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 100))
      active--
    })
    const batcher = createDebouncedBatcher(run, 10)
    batcher.add('a.md')
    await vi.advanceTimersByTimeAsync(20)
    batcher.add('b.md')
    await vi.advanceTimersByTimeAsync(300)
    expect(run).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
  })

  it('cancel drops pending items', async () => {
    const run = vi.fn(async () => {})
    const batcher = createDebouncedBatcher(run, 100)
    batcher.add('a.md')
    batcher.cancel()
    await vi.advanceTimersByTimeAsync(500)
    expect(run).not.toHaveBeenCalled()
  })
})

const empty = (): IndexResult => ({ indexed: [], unchanged: 0, deleted: [], failed: [] })

function fakeIndexer() {
  const synced: string[][] = []
  let fullScans = 0
  const indexer: VaultIndexer = {
    async fullScan() {
      fullScans++
      return empty()
    },
    async syncPaths(paths) {
      synced.push([...paths].sort())
      return empty()
    },
    async refreshAllowLlm() {
      return { updated: 0 }
    },
  }
  return { indexer, synced, fullScans: () => fullScans }
}

/** Waits until `check` passes; file events take a moment to arrive, longest on Windows. */
async function eventually(check: () => void, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

describe('watchVault', () => {
  let root: string
  let watcher: VaultWatcher | undefined

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pythia-watch-'))
    await writeFile(path.join(root, 'Existing.md'), '# Existing')
    await mkdir(path.join(root, 'Folder'))
    await writeFile(path.join(root, 'Folder', 'Inner.md'), '# Inner')
  })

  afterEach(async () => {
    await watcher?.close()
    watcher = undefined
    await rm(root, { recursive: true, force: true })
  })

  it('reports added, changed and deleted notes as vault-relative paths, ignoring dot folders', async () => {
    const fake = fakeIndexer()
    watcher = watchVault({ root, indexer: fake.indexer, debounceMs: 200, onResult: () => {} })
    await watcher.ready
    expect(fake.synced).toEqual([])

    await writeFile(path.join(root, 'New.md'), '# New')
    await writeFile(path.join(root, 'Existing.md'), '# Existing, edited')
    await unlink(path.join(root, 'Folder', 'Inner.md'))
    await mkdir(path.join(root, '.obsidian'))
    await writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}')

    await eventually(() => {
      expect(fake.synced.flat().sort()).toEqual(['Existing.md', 'Folder/Inner.md', 'New.md'])
    })
    expect(fake.synced.flat().some((p) => p.includes('.obsidian'))).toBe(false)
  })

  it('debounces rapid saves of one note into a single sync', async () => {
    const fake = fakeIndexer()
    watcher = watchVault({ root, indexer: fake.indexer, debounceMs: 400, onResult: () => {} })
    await watcher.ready
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(root, 'Existing.md'), `# Existing ${i}`)
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    await eventually(() => expect(fake.synced).toEqual([['Existing.md']]))
    // Nothing else arrives once the burst has been handled.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(fake.synced).toEqual([['Existing.md']])
  })

  it('answers a deleted folder with a full scan', async () => {
    const fake = fakeIndexer()
    watcher = watchVault({ root, indexer: fake.indexer, debounceMs: 200, onResult: () => {} })
    await watcher.ready
    await rm(path.join(root, 'Folder'), { recursive: true, force: true })
    await eventually(() => expect(fake.fullScans()).toBe(1))
  })

  it('passes indexer errors to onError and keeps watching', async () => {
    const errors: unknown[] = []
    const fake = fakeIndexer()
    let first = true
    const indexer: VaultIndexer = {
      fullScan: fake.indexer.fullScan,
      refreshAllowLlm: fake.indexer.refreshAllowLlm,
      async syncPaths(paths) {
        if (first) {
          first = false
          throw new Error('db down')
        }
        return fake.indexer.syncPaths(paths)
      },
    }
    watcher = watchVault({ root, indexer, debounceMs: 150, onResult: () => {}, onError: (e) => errors.push(e) })
    await watcher.ready
    await writeFile(path.join(root, 'A.md'), '# A')
    await eventually(() => expect(errors).toHaveLength(1))
    await writeFile(path.join(root, 'B.md'), '# B')
    await eventually(() => expect(fake.synced.flat()).toContain('B.md'))
  })
})

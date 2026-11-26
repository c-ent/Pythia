import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb, SYNC_STATE_KEY, type CachedDocument } from './db'
import { formatBytes, readCacheCounts, readStorageInfo, requestPersistence } from './storage'

const doc = (id: number, sourceKind: CachedDocument['sourceKind'], sourceName: string): CachedDocument => ({
  id,
  sourceKind,
  sourceName,
  path: `file-${id}.md`,
  title: `File ${id}`,
  language: null,
  allowLlm: true,
  mtime: null,
  updatedAt: '2026-11-26T00:00:00.000Z',
  content: 'text',
  truncated: false,
})

// jsdom has no `navigator.storage`; each test defines the one it needs.
function stubStorage(storage: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', { configurable: true, get: () => storage })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'storage')
})

describe('formatBytes', () => {
  it('uses binary units with one decimal under ten', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB')
    expect(formatBytes(312 * 1024 * 1024)).toBe('312 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
  })
})

describe('readStorageInfo', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the estimate and persistence', async () => {
    stubStorage({
      estimate: () => Promise.resolve({ usage: 1024, quota: 4096 }),
      persisted: () => Promise.resolve(true),
    })
    expect(await readStorageInfo()).toEqual({ usage: 1024, quota: 4096, persisted: true })
  })

  it('returns nulls when the browser has no storage manager or it fails', async () => {
    stubStorage(undefined)
    expect(await readStorageInfo()).toEqual({ usage: null, quota: null, persisted: null })
    stubStorage({ estimate: () => Promise.reject(new Error('no')), persisted: () => Promise.reject(new Error('no')) })
    expect(await readStorageInfo()).toEqual({ usage: null, quota: null, persisted: null })
  })
})

describe('requestPersistence', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns what the browser grants, false when unsupported or failing', async () => {
    stubStorage({ persist: () => Promise.resolve(true) })
    expect(await requestPersistence()).toBe(true)
    stubStorage({ persist: () => Promise.reject(new Error('no')) })
    expect(await requestPersistence()).toBe(false)
    stubStorage({})
    expect(await requestPersistence()).toBe(false)
  })
})

describe('readCacheCounts', () => {
  it('counts notes and repo files separately and reads the last sync time', async () => {
    const db = new OfflineDb(`storage-test-${Math.random()}`)
    await db.documents.bulkPut([
      doc(1, 'obsidian', 'vault'),
      doc(2, 'keep', 'keep'),
      doc(3, 'repo', 'alpha'),
      doc(4, 'repo', 'beta'),
      doc(5, 'repo', 'beta'),
    ])
    expect(await readCacheCounts(db)).toEqual({ notes: 2, repoFiles: 3, syncedAt: null })
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '9', repos: [], syncedAt: '2026-11-26T01:00:00.000Z' })
    expect((await readCacheCounts(db)).syncedAt).toBe('2026-11-26T01:00:00.000Z')
    db.close()
  })
})

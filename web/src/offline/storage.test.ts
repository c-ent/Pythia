import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb, SYNC_STATE_KEY, type CachedDocument } from './db'
import { formatBytes, readCacheBreakdown, readCacheCounts, readStorageInfo, requestPersistence } from './storage'

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
      doc(6, 'gdrive', 'gdrive'),
    ])
    // Drive files are cached like notes.
    expect(await readCacheCounts(db)).toEqual({ notes: 3, repoFiles: 3, syncedAt: null })
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '9', repos: [], syncedAt: '2026-11-26T01:00:00.000Z' })
    expect((await readCacheCounts(db)).syncedAt).toBe('2026-11-26T01:00:00.000Z')
    db.close()
  })
})

describe('readCacheBreakdown', () => {
  it('adds up the UTF-8 size of notes and of each repo, and reads what the last sync covered', async () => {
    const db = new OfflineDb(`breakdown-test-${Math.random()}`)
    expect(await readCacheBreakdown(db)).toEqual({
      notes: { count: 0, bytes: 0 },
      repos: new Map(),
      syncedRepos: [],
      syncedAt: null,
    })
    await db.documents.bulkPut([
      { ...doc(1, 'obsidian', 'vault'), content: 'héllo' },
      { ...doc(2, 'keep', 'keep'), content: 'abc' },
      { ...doc(3, 'repo', 'alpha'), content: 'abcd' },
      { ...doc(4, 'repo', 'beta'), content: 'ab' },
      { ...doc(5, 'repo', 'beta'), content: 'abc' },
    ])
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '9', repos: ['alpha', 'beta'], syncedAt: '2026-11-26T01:00:00.000Z' })
    const breakdown = await readCacheBreakdown(db)
    // "é" is two bytes in UTF-8.
    expect(breakdown.notes).toEqual({ count: 2, bytes: 9 })
    expect([...breakdown.repos]).toEqual([
      ['alpha', { count: 1, bytes: 4 }],
      ['beta', { count: 2, bytes: 5 }],
    ])
    expect(breakdown.syncedRepos).toEqual(['alpha', 'beta'])
    expect(breakdown.syncedAt).toBe('2026-11-26T01:00:00.000Z')
    db.close()
  })
})

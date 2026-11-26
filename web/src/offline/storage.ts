import Dexie from 'dexie'
import type { OfflineDb } from './db'
import { readSyncState } from './sync'

/**
 * What the Settings storage panel shows (R11): browser storage use, whether
 * the browser promised to keep it (`navigator.storage.persist()`), and how
 * much of the index is cached on this device. Every value is null when the
 * browser does not offer it (older Safari, private mode, tests).
 */

export interface StorageInfo {
  usage: number | null
  quota: number | null
  persisted: boolean | null
}

export interface CacheCounts {
  notes: number
  repoFiles: number
  syncedAt: string | null
}

const storageManager = (): StorageManager | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageManager | undefined)

export async function readStorageInfo(): Promise<StorageInfo> {
  const manager = storageManager()
  const [estimate, persisted] = await Promise.all([
    manager?.estimate === undefined ? null : manager.estimate().catch(() => null),
    manager?.persisted === undefined ? null : manager.persisted().catch(() => null),
  ])
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted }
}

/** Asks the browser to keep offline data under storage pressure. True when granted. */
export async function requestPersistence(): Promise<boolean> {
  const manager = storageManager()
  if (manager?.persist === undefined) return false
  try {
    return await manager.persist()
  } catch {
    return false
  }
}

export async function readCacheCounts(db: OfflineDb): Promise<CacheCounts> {
  const [total, repoFiles, state] = await Promise.all([
    db.documents.count(),
    db.documents
      .where('[sourceKind+sourceName]')
      .between(['repo', Dexie.minKey], ['repo', Dexie.maxKey], true, true)
      .count(),
    readSyncState(db),
  ])
  return { notes: total - repoFiles, repoFiles, syncedAt: state?.syncedAt ?? null }
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** 1 KB = 1024 B, one decimal under 10 units ("4.2 MB", "312 MB"). */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Pool } from 'pg'

export const STORAGE_REFRESH_INTERVAL_MS = 15 * 60_000
const OLLAMA_TIMEOUT_MS = 3_000
const TOP_DIR_LIMIT = 12
const TOP_FILE_LIMIT = 15
const TOP_DB_TABLE_LIMIT = 10
const YIELD_EVERY_ENTRIES = 200
const MAX_TRACKED_INODES = 250_000
const VIRTUAL_HOST_ROOT_DIRS = new Set(['proc', 'sys', 'dev', 'run'])

export interface StorageFolderEntry {
  path: string
  bytes: number
}

export interface StorageFileEntry {
  path: string
  bytes: number
}

export interface DatabaseTableUsage {
  name: string
  bytes: number
}

export interface OllamaModelUsage {
  name: string
  diskBytes: number
  memoryBytes: number
}

export type StorageAreaId = 'vault' | 'repos' | 'gdrive' | 'database' | 'ollama'

export interface StorageAreaUsage {
  id: StorageAreaId
  label: string
  path: string | null
  bytes: number | null
  note: string | null
}

export type StorageScanStatus = 'idle' | 'scanning' | 'ready' | 'error'

export interface StorageScanSnapshot {
  status: StorageScanStatus
  scannedAt: string | null
  error: string | null
  hostRootMounted: boolean
  unreadableDirs: number
  areas: StorageAreaUsage[]
  hostTopDirs: StorageFolderEntry[]
  largestDirs: StorageFolderEntry[]
  largestFiles: StorageFileEntry[]
  databaseTables: DatabaseTableUsage[]
  ollamaModels: OllamaModelUsage[]
}

export const EMPTY_STORAGE_SCAN: StorageScanSnapshot = {
  status: 'idle',
  scannedAt: null,
  error: null,
  hostRootMounted: false,
  unreadableDirs: 0,
  areas: [],
  hostTopDirs: [],
  largestDirs: [],
  largestFiles: [],
  databaseTables: [],
  ollamaModels: [],
}

export interface StorageScanOptions {
  pool: Pick<Pool, 'query'>
  ollamaUrl: string
  hostRoot?: string | null
  vaultPath?: string | null
  reposDir?: string | null
  driveDir?: string | null
  fetch?: typeof fetch
  now?: () => number
  refreshIntervalMs?: number
  autoScan?: boolean
  databaseStats?: () => Promise<{ totalBytes: number; tables: DatabaseTableUsage[] }>
  ollamaStats?: () => Promise<OllamaModelUsage[] | null>
  log?: (message: string) => void
}

export interface StorageScanService {
  snapshot(): StorageScanSnapshot
  scan(): Promise<StorageScanSnapshot>
  close(): void
}

interface DirNode {
  fsPath: string
  displayPath: string
  depth: number
  parentIdx: number | null
  ownBytes: number
  totalBytes: number
  childIndices: number[]
}

interface TreeScanResult {
  totalBytes: number
  unreadableDirs: number
  topLevel: StorageFolderEntry[]
  largestDirs: StorageFolderEntry[]
  largestFiles: StorageFileEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPermissionError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  return code === 'EACCES' || code === 'EPERM'
}

function pushTopFile(list: StorageFileEntry[], entry: StorageFileEntry, limit: number): void {
  if (entry.bytes <= 0) return
  if (list.length < limit || entry.bytes > list[list.length - 1]!.bytes) {
    list.push(entry)
    list.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    if (list.length > limit) list.length = limit
  }
}

function joinDisplayPath(base: string, name: string): string {
  if (base === '/') return `/${name}`
  if (base.includes('\\')) return path.join(base, name)
  return `${base.replace(/\/+$/, '')}/${name}`
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Walks a directory tree on a single filesystem without following symlinks,
 * accumulating directory sizes bottom-up and tracking top files and folders.
 */
export async function scanDirectoryTree(
  rootPath: string,
  options: { displayRoot?: string; skipHostVirtual?: boolean; minDirDepth?: number } = {},
): Promise<TreeScanResult | null> {
  let rootStat: Stats
  try {
    rootStat = await lstat(rootPath)
  } catch {
    return null
  }
  if (!rootStat.isDirectory()) return null

  const rootDev = rootStat.dev
  const displayRoot = options.displayRoot ?? rootPath
  const minDirDepth = options.minDirDepth ?? 1
  const nodes: DirNode[] = [
    {
      fsPath: rootPath,
      displayPath: displayRoot,
      depth: 0,
      parentIdx: null,
      ownBytes: 0,
      totalBytes: 0,
      childIndices: [],
    },
  ]
  const seenInodes = new Set<string>()
  const rootFiles: StorageFolderEntry[] = []
  const largestFiles: StorageFileEntry[] = []
  let unreadableDirs = 0
  let processed = 0
  const stack: number[] = [0]

  while (stack.length > 0) {
    const idx = stack.pop()!
    const node = nodes[idx]!
    let entries: Dirent[]
    try {
      entries = await readdir(node.fsPath, { withFileTypes: true })
    } catch (error) {
      if (isPermissionError(error)) unreadableDirs += 1
      continue
    }

    for (const entry of entries) {
      processed += 1
      if (processed % YIELD_EVERY_ENTRIES === 0) await yieldToEventLoop()
      if (entry.isSymbolicLink()) continue
      if (options.skipHostVirtual && node.depth === 0 && VIRTUAL_HOST_ROOT_DIRS.has(entry.name)) {
        continue
      }

      const childFsPath = path.join(node.fsPath, entry.name)
      const childDisplayPath = joinDisplayPath(node.displayPath, entry.name)
      let childStat: Stats
      try {
        childStat = await lstat(childFsPath)
      } catch (error) {
        if (isPermissionError(error)) unreadableDirs += 1
        continue
      }

      if (childStat.isSymbolicLink()) continue
      if (childStat.dev !== rootDev) continue

      if (childStat.isDirectory()) {
        const childIdx = nodes.length
        nodes.push({
          fsPath: childFsPath,
          displayPath: childDisplayPath,
          depth: node.depth + 1,
          parentIdx: idx,
          ownBytes: 0,
          totalBytes: 0,
          childIndices: [],
        })
        node.childIndices.push(childIdx)
        stack.push(childIdx)
      } else if (childStat.isFile()) {
        if (childStat.nlink > 1) {
          const inodeKey = `${childStat.dev}:${childStat.ino}`
          if (seenInodes.has(inodeKey)) continue
          if (seenInodes.size < MAX_TRACKED_INODES) seenInodes.add(inodeKey)
        }
        node.ownBytes += childStat.size
        pushTopFile(largestFiles, { path: childDisplayPath, bytes: childStat.size }, TOP_FILE_LIMIT)
        if (node.depth === 0 && childStat.size >= 1024 * 1024) {
          rootFiles.push({ path: childDisplayPath, bytes: childStat.size })
        }
      }
    }
  }

  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!
    node.totalBytes += node.ownBytes
    if (node.parentIdx !== null) {
      nodes[node.parentIdx]!.totalBytes += node.totalBytes
    }
  }

  const topLevel = [
    ...nodes
      .filter((node) => node.depth === 1 && node.totalBytes > 0)
      .map((node) => ({ path: node.displayPath, bytes: node.totalBytes })),
    ...rootFiles,
  ]
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, TOP_DIR_LIMIT)

  // Skip parent folders when a single child already holds >= 90% of their size so
  // nested directories like /var/lib/docker/overlay2 surface instead of /var/lib.
  const largestDirs = nodes
    .filter((node) => {
      if (node.depth < minDirDepth || node.totalBytes <= 0) return false
      return !node.childIndices.some((childIdx) => nodes[childIdx]!.totalBytes >= node.totalBytes * 0.9)
    })
    .map((node) => ({ path: node.displayPath, bytes: node.totalBytes }))
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, TOP_DIR_LIMIT)

  return {
    totalBytes: nodes[0]!.totalBytes,
    unreadableDirs,
    topLevel,
    largestDirs,
    largestFiles,
  }
}

async function queryDatabaseStats(pool: Pick<Pool, 'query'>): Promise<{ totalBytes: number; tables: DatabaseTableUsage[] }> {
  const [sizeRes, tablesRes] = await Promise.all([
    pool.query<{ size: string }>('SELECT pg_database_size(current_database()) AS size'),
    pool.query<{ name: string; bytes: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm')
       ORDER BY bytes DESC, c.relname ASC
       LIMIT $1`,
      [TOP_DB_TABLE_LIMIT],
    ),
  ])
  const totalBytes = Number(sizeRes.rows[0]?.size ?? 0)
  const tables = tablesRes.rows
    .map((row) => ({ name: row.name, bytes: Number(row.bytes) }))
    .filter((row) => Number.isFinite(row.bytes) && row.bytes >= 0)
  return { totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0, tables }
}

async function queryOllamaModels(ollamaUrl: string, fetchFn: typeof fetch): Promise<OllamaModelUsage[] | null> {
  const base = ollamaUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
  timer.unref?.()
  try {
    const [tagsRes, psRes] = await Promise.all([
      fetchFn(`${base}/api/tags`, { signal: controller.signal }),
      fetchFn(`${base}/api/ps`, { signal: controller.signal }).catch(() => null),
    ])
    if (!tagsRes.ok) {
      await tagsRes.body?.cancel().catch(() => {})
      return null
    }
    const tagsJson: unknown = await tagsRes.json()
    const psJson: unknown = psRes !== null && psRes.ok ? await psRes.json().catch(() => null) : null
    if (psRes !== null && !psRes.ok) {
      await psRes.body?.cancel().catch(() => {})
    }

    const loadedMemory = new Map<string, number>()
    if (isRecord(psJson) && Array.isArray(psJson.models)) {
      for (const entry of psJson.models) {
        if (!isRecord(entry)) continue
        const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
        if (!name) continue
        const mem =
          typeof entry.size_vram === 'number' && entry.size_vram > 0
            ? entry.size_vram
            : typeof entry.size === 'number' && entry.size > 0
              ? entry.size
              : 0
        loadedMemory.set(name, (loadedMemory.get(name) ?? 0) + mem)
      }
    }

    const models: OllamaModelUsage[] = []
    if (isRecord(tagsJson) && Array.isArray(tagsJson.models)) {
      for (const entry of tagsJson.models) {
        if (!isRecord(entry)) continue
        const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
        if (!name) continue
        const diskBytes = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : 0
        models.push({ name, diskBytes, memoryBytes: loadedMemory.get(name) ?? 0 })
      }
    }
    for (const [name, memoryBytes] of loadedMemory) {
      if (!models.some((model) => model.name === name)) {
        models.push({ name, diskBytes: 0, memoryBytes })
      }
    }
    return models.sort((a, b) => b.diskBytes - a.diskBytes || b.memoryBytes - a.memoryBytes || a.name.localeCompare(b.name))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function mergeTopEntries<T extends { path: string; bytes: number }>(groups: T[][], limit: number): T[] {
  const byPath = new Map<string, T>()
  for (const group of groups) {
    for (const item of group) {
      const existing = byPath.get(item.path)
      if (existing === undefined || item.bytes > existing.bytes) {
        byPath.set(item.path, item)
      }
    }
  }
  return [...byPath.values()]
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
    .slice(0, limit)
}

/** Periodically scans host and Pythia storage, database tables, and Ollama models. */
export function createStorageScan(options: StorageScanOptions): StorageScanService {
  const now = options.now ?? Date.now
  const fetchFn = options.fetch ?? fetch
  const intervalMs = options.refreshIntervalMs ?? STORAGE_REFRESH_INTERVAL_MS
  const log = options.log ?? ((message: string) => console.error(message))

  let current: StorageScanSnapshot = EMPTY_STORAGE_SCAN
  let pending: Promise<StorageScanSnapshot> | null = null

  const runScan = async (): Promise<StorageScanSnapshot> => {
    const [dbStats, ollamaModels, hostScan, vaultScan, reposScan, driveScan] = await Promise.all([
      (options.databaseStats ?? (() => queryDatabaseStats(options.pool)))().catch(() => null),
      options.ollamaStats !== undefined ? options.ollamaStats().catch(() => null) : queryOllamaModels(options.ollamaUrl, fetchFn),
      options.hostRoot ? scanDirectoryTree(options.hostRoot, { displayRoot: '/', skipHostVirtual: true, minDirDepth: 2 }) : Promise.resolve(null),
      options.vaultPath ? scanDirectoryTree(options.vaultPath, { displayRoot: options.vaultPath, minDirDepth: 1 }) : Promise.resolve(null),
      options.reposDir ? scanDirectoryTree(options.reposDir, { displayRoot: options.reposDir, minDirDepth: 1 }) : Promise.resolve(null),
      options.driveDir ? scanDirectoryTree(options.driveDir, { displayRoot: options.driveDir, minDirDepth: 1 }) : Promise.resolve(null),
    ])

    const areas: StorageAreaUsage[] = [
      {
        id: 'database',
        label: 'Postgres database',
        path: null,
        bytes: dbStats === null ? null : dbStats.totalBytes,
        note: dbStats === null ? 'Database query failed' : `${dbStats.tables.length} tables`,
      },
      {
        id: 'ollama',
        label: 'Ollama models',
        path: null,
        bytes: ollamaModels === null ? null : ollamaModels.reduce((sum, model) => sum + model.diskBytes, 0),
        note:
          ollamaModels === null
            ? 'Ollama unreachable'
            : ollamaModels.length === 0
              ? 'No models installed'
              : `${ollamaModels.length} installed`,
      },
      {
        id: 'vault',
        label: 'Obsidian vault',
        path: options.vaultPath ?? null,
        bytes: vaultScan?.totalBytes ?? null,
        note: !options.vaultPath ? 'Not configured' : vaultScan === null ? 'Directory unavailable' : null,
      },
      {
        id: 'repos',
        label: 'GitHub repos',
        path: options.reposDir ?? null,
        bytes: reposScan?.totalBytes ?? null,
        note: !options.reposDir ? 'Not configured' : reposScan === null ? 'Directory unavailable' : null,
      },
      {
        id: 'gdrive',
        label: 'Google Drive mirror',
        path: options.driveDir ?? null,
        bytes: driveScan?.totalBytes ?? null,
        note: !options.driveDir ? 'Not configured' : driveScan === null ? 'Directory unavailable' : null,
      },
    ]

    const dirGroups = [
      ...(hostScan === null ? [] : [hostScan.largestDirs]),
      ...(vaultScan === null ? [] : [vaultScan.largestDirs]),
      ...(reposScan === null ? [] : [reposScan.largestDirs]),
      ...(driveScan === null ? [] : [driveScan.largestDirs]),
    ]
    const fileGroups = [
      ...(hostScan === null ? [] : [hostScan.largestFiles]),
      ...(vaultScan === null ? [] : [vaultScan.largestFiles]),
      ...(reposScan === null ? [] : [reposScan.largestFiles]),
      ...(driveScan === null ? [] : [driveScan.largestFiles]),
    ]
    const unreadableDirs =
      (hostScan?.unreadableDirs ?? 0) +
      (vaultScan?.unreadableDirs ?? 0) +
      (reposScan?.unreadableDirs ?? 0) +
      (driveScan?.unreadableDirs ?? 0)

    return {
      status: 'ready',
      scannedAt: new Date(now()).toISOString(),
      error: null,
      hostRootMounted: hostScan !== null,
      unreadableDirs,
      areas,
      hostTopDirs: hostScan?.topLevel ?? [],
      largestDirs: mergeTopEntries(dirGroups, TOP_DIR_LIMIT),
      largestFiles: mergeTopEntries(fileGroups, TOP_FILE_LIMIT),
      databaseTables: dbStats?.tables ?? [],
      ollamaModels: ollamaModels ?? [],
    }
  }

  const scan = async (): Promise<StorageScanSnapshot> => {
    if (pending !== null) return pending
    current = { ...current, status: 'scanning', error: null }
    pending = (async () => {
      try {
        current = await runScan()
      } catch (error) {
        const reason = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : 'UnknownError'
        current = { ...current, status: 'error', error: reason }
        log(`storage scan failed: ${reason}`)
      } finally {
        pending = null
      }
      return current
    })()
    return pending
  }

  if (options.autoScan !== false) {
    void scan()
  }
  const timer = setInterval(() => void scan(), intervalMs)
  timer.unref()

  return {
    snapshot: () => current,
    scan,
    close(): void {
      clearInterval(timer)
    },
  }
}

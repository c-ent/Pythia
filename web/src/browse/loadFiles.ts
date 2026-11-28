import { ApiError } from '../api/client'
import { listFiles, type DocumentInfo } from '../api/documents'
import type { SourceKind } from '../api/search'
import { offlineDb, type CachedDocument } from '../offline/db'

const SUMMARY_PATH = ':SUMMARY'

export interface LoadedFiles {
  documents: DocumentInfo[]
  total: number
  /** True when the list came from this device's offline copy (R11). */
  cached: boolean
}

function fromCachedInfo(doc: CachedDocument): DocumentInfo {
  return {
    id: doc.id,
    source: { kind: doc.sourceKind as SourceKind, name: doc.sourceName },
    path: doc.path,
    title: doc.title,
    language: doc.language,
    allowLlm: doc.allowLlm,
    mtime: doc.mtime,
    updatedAt: doc.updatedAt,
  }
}

async function readOfflineFiles(source: SourceKind, name?: string): Promise<LoadedFiles> {
  if (typeof indexedDB === 'undefined') return { documents: [], total: 0, cached: true }
  const db = offlineDb()
  const rows =
    name !== undefined
      ? await db.documents.where('[sourceKind+sourceName]').equals([source, name]).toArray()
      : await db.documents
          .where('[sourceKind+sourceName]')
          .between([source, ''], [source, '\uffff'])
          .toArray()
  const filtered = rows
    .filter((row) => !(source === 'repo' && row.path === SUMMARY_PATH))
    .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path) || a.id - b.id)
    .map(fromCachedInfo)
  return { documents: filtered, total: filtered.length, cached: true }
}

/**
 * Loads the file list for a source or repo. Offline, or when the server
 * cannot be reached, reads the cached files from IndexedDB instead.
 */
export async function loadFiles(
  params: { source: SourceKind; name?: string },
  signal?: AbortSignal,
): Promise<LoadedFiles> {
  const online = navigator.onLine
  if (online) {
    try {
      const response = await listFiles(params, signal)
      return { documents: response.documents, total: response.total, cached: false }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 0)) throw error
    }
  }
  return readOfflineFiles(params.source, params.name)
}

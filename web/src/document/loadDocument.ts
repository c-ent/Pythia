import { ApiError } from '../api/client'
import { getDocument, type DocumentView } from '../api/documents'
import { offlineDb } from '../offline/db'
import { fromCached, NotCachedError } from './format'

export interface LoadedDocument {
  doc: DocumentView
  /** True when the text came from this device's offline copy (R11). */
  cached: boolean
}

/**
 * Asks the server for the document. Offline, or when the server cannot be
 * reached, it reads the copy synced into IndexedDB instead; any other server
 * answer (404, 500) is final, so a deleted note never shows from a stale copy.
 */
export async function loadDocument(id: number, signal?: AbortSignal): Promise<LoadedDocument> {
  const online = navigator.onLine
  if (online) {
    try {
      return { doc: await getDocument(id, signal), cached: false }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 0)) throw error
    }
  }
  // No IndexedDB (old browser, private mode): nothing is cached.
  const stored = typeof indexedDB === 'undefined' ? undefined : await offlineDb().documents.get(id)
  const doc = stored === undefined ? null : fromCached(stored)
  if (doc === null) throw new NotCachedError(!online)
  return { doc, cached: true }
}

import type { SearchableKind } from '../db/searchStore.js'
import type { SyncDocumentRow, SyncRow, SyncStore } from '../db/syncStore.js'

/**
 * In-memory `SyncStore` with the same rules as the Postgres one: one change
 * sequence, tombstones on delete, `work` and disabled sources never sent,
 * repo files only for the requested repos. Used by tests.
 */
export interface MemorySyncStore extends SyncStore {
  put(doc: Omit<SyncDocumentRow, 'seq' | 'sourceKind'> & { sourceKind: SearchableKind | 'work'; enabled?: boolean }): number
  remove(id: number): void
  setEnabled(kind: SearchableKind | 'work', name: string, enabled: boolean): void
}

type Stored = Omit<SyncDocumentRow, 'sourceKind'> & { sourceKind: SearchableKind | 'work'; enabled: boolean }

export function createMemorySyncStore(): MemorySyncStore {
  let seq = 0
  const docs = new Map<number, Stored>()
  const tombstones: Array<{ seq: number; id: number }> = []

  return {
    put(doc) {
      seq += 1
      docs.set(doc.id, { ...doc, enabled: doc.enabled ?? true, seq })
      return seq
    },
    remove(id) {
      if (!docs.delete(id)) return
      seq += 1
      tombstones.push({ seq, id })
    },
    setEnabled(kind, name, enabled) {
      for (const doc of docs.values()) {
        if (doc.sourceKind === kind && doc.sourceName === name && doc.enabled !== enabled) {
          seq += 1
          doc.enabled = enabled
          doc.seq = seq
        }
      }
    },
    async highWater() {
      return seq
    },
    async changes({ after, upTo, repos, limit }) {
      const rows: SyncRow[] = []
      for (const doc of docs.values()) {
        if (doc.seq <= after || doc.seq > upTo) continue
        const { enabled, sourceKind, ...rest } = doc
        const visible = enabled && sourceKind !== 'work' && (sourceKind !== 'repo' || repos.includes(rest.sourceName))
        if (!visible) {
          rows.push({ type: 'delete', seq: rest.seq, id: rest.id })
          continue
        }
        rows.push({ type: 'upsert', doc: { ...rest, sourceKind: sourceKind as SearchableKind } })
      }
      for (const stone of tombstones) {
        if (stone.seq > after && stone.seq <= upTo) rows.push({ type: 'delete', ...stone })
      }
      const seqOf = (row: SyncRow): number => (row.type === 'upsert' ? row.doc.seq : row.seq)
      return rows.sort((a, b) => seqOf(a) - seqOf(b)).slice(0, limit)
    },
  }
}

import type { Pool } from 'pg'
import { SEARCHABLE_KINDS, type SearchableKind } from './searchStore.js'

export interface SourceStatusRow {
  kind: SearchableKind
  name: string
  enabled: boolean
  documents: number
  chunks: number
  /** Last time any of its documents changed; null before the first index. */
  updatedAt: Date | null
}

/** What the Import page's index status needs from the database. */
export interface StatusStore {
  /** Every source except `kind = 'work'`, by kind and name. */
  listSources(): Promise<SourceStatusRow[]>
}

interface StatusDbRow {
  kind: SearchableKind
  name: string
  enabled: boolean
  documents: string
  chunks: string
  updated_at: Date | null
}

export function createPgStatusStore(pool: Pool): StatusStore {
  return {
    async listSources() {
      const { rows } = await pool.query<StatusDbRow>(
        `SELECT s.kind, s.name, s.enabled,
                (SELECT count(*) FROM documents d WHERE d.source_id = s.id) AS documents,
                (SELECT count(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_id = s.id) AS chunks,
                (SELECT max(d.updated_at) FROM documents d WHERE d.source_id = s.id) AS updated_at
         FROM sources s
         WHERE s.kind = ANY ($1::text[])
         ORDER BY s.kind, s.name`,
        [[...SEARCHABLE_KINDS]],
      )
      return rows.map((row) => ({
        kind: row.kind,
        name: row.name,
        enabled: row.enabled,
        documents: Number(row.documents),
        chunks: Number(row.chunks),
        updatedAt: row.updated_at,
      }))
    },
  }
}

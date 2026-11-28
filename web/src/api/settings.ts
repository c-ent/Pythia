import { apiFetch } from './client'

// Mirrors `GET` / `PUT /api/settings/llm-exclusions` (server/src/routes/settings.ts, R3, R16).

/**
 * - `folder`, `note`: vault-relative paths of Obsidian notes.
 * - `tag`: Obsidian notes with the tag or one nested under it, stored lower case without `#`.
 * - `repo`: every document of the repo with that name.
 * - `keep`: every Google Keep note; its `path` is always `keep`.
 * - `gdrive`: Google Drive documents; `path` is `/` for the whole Drive, else a
 *   folder in My Drive (its files and subfolders).
 */
export type LlmExclusionKind = 'folder' | 'note' | 'tag' | 'repo' | 'keep' | 'gdrive'

/** One rule on the "Kept away from Gemini" list. */
export interface LlmExclusion {
  kind: LlmExclusionKind
  path: string
}

/** A rule as the server returns it, with how many stored documents it covers now. */
export interface CountedLlmExclusion extends LlmExclusion {
  documents: number
}

export interface CatalogFolder {
  path: string
  documents: number
}

export interface CatalogTag {
  tag: string
  documents: number
}

/** Browseable Obsidian, Drive and Keep items returned by `GET /api/settings/llm-exclusions/catalog`. */
export interface LlmExclusionCatalog {
  obsidian: {
    folders: CatalogFolder[]
    notes: string[]
    tags: CatalogTag[]
  }
  gdrive: {
    totalDocuments: number
    folders: CatalogFolder[]
    files: string[]
  }
  keep: {
    documents: number
  }
}

export const EMPTY_EXCLUSION_CATALOG: LlmExclusionCatalog = {
  obsidian: { folders: [], notes: [], tags: [] },
  gdrive: { totalDocuments: 0, folders: [], files: [] },
  keep: { documents: 0 },
}

export async function getLlmExclusions(signal?: AbortSignal): Promise<CountedLlmExclusion[]> {
  const res = await apiFetch('/api/settings/llm-exclusions', { signal })
  return ((await res.json()) as { exclusions: CountedLlmExclusion[] }).exclusions
}

export async function getLlmExclusionCatalog(signal?: AbortSignal): Promise<LlmExclusionCatalog> {
  const res = await apiFetch('/api/settings/llm-exclusions/catalog', { signal })
  return (await res.json()) as LlmExclusionCatalog
}

/** Saves the whole list, replacing the stored one, and returns it as the server keeps it (deduplicated, sorted, counted). */
export async function saveLlmExclusions(exclusions: readonly LlmExclusion[]): Promise<CountedLlmExclusion[]> {
  const res = await apiFetch('/api/settings/llm-exclusions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exclusions: exclusions.map(({ kind, path }) => ({ kind, path })) }),
  })
  return ((await res.json()) as { exclusions: CountedLlmExclusion[] }).exclusions
}

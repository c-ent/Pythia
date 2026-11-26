import { apiFetch } from './client'

// Mirrors `GET` / `PUT /api/settings/llm-exclusions` (server/src/routes/settings.ts).

export type LlmExclusionKind = 'folder' | 'note'

/** A vault folder or a single note kept away from Gemini. `path` is vault-relative. */
export interface LlmExclusion {
  kind: LlmExclusionKind
  path: string
}

export async function getLlmExclusions(signal?: AbortSignal): Promise<LlmExclusion[]> {
  const res = await apiFetch('/api/settings/llm-exclusions', { signal })
  return ((await res.json()) as { exclusions: LlmExclusion[] }).exclusions
}

/** Saves the whole list, replacing the stored one, and returns it as the server keeps it (deduplicated, sorted). */
export async function saveLlmExclusions(exclusions: readonly LlmExclusion[]): Promise<LlmExclusion[]> {
  const res = await apiFetch('/api/settings/llm-exclusions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exclusions }),
  })
  return ((await res.json()) as { exclusions: LlmExclusion[] }).exclusions
}

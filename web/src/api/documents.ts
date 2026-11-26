import { apiFetch } from './client'
import type { SourceRef } from './search'

// Mirrors `GET /api/documents/:id` (DocumentView in server/src/search/searchService.ts).
// Dates arrive as ISO strings.

export interface DocumentView {
  id: number
  source: SourceRef
  path: string
  title: string
  /** `markdown` for notes and READMEs, a code language for repo files, or null. */
  language: string | null
  allowLlm: boolean
  mtime: string | null
  updatedAt: string
  /** The document text, capped by the server; frontmatter is not kept. */
  content: string
  truncated: boolean
  /** Length of the full text before the cap. */
  totalChars: number
}

export async function getDocument(id: number, signal?: AbortSignal): Promise<DocumentView> {
  const res = await apiFetch(`/api/documents/${id}`, { signal })
  return (await res.json()) as DocumentView
}

import { apiFetch } from './client'
import type { SourceRef } from './search'

// Mirrors `GET /api/documents/:id` (DocumentView in server/src/search/searchService.ts).
// Dates arrive as ISO strings.

/** A document without its text, as listed by `GET /api/recent` (DocumentInfo on the server). */
export interface DocumentInfo {
  id: number
  source: SourceRef
  path: string
  title: string
  /** `markdown` for notes and READMEs, a code language for repo files, or null. */
  language: string | null
  allowLlm: boolean
  mtime: string | null
  updatedAt: string
}

export interface DocumentView extends DocumentInfo {
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

import { apiFetch } from './client'
import { recentQueriesChanged } from './recent'
import type { Snippet, SourceKind, SourceRef } from './search'

// Mirrors the server's Ask types (server/src/ask/askService.ts).

export type AskEngine = 'gemini' | 'ollama' | 'retrieval'

/** Why an earlier step of the Gemini → local model → retrieval chain did not answer, in chain order. */
export type FallbackReason =
  | 'no_results'
  | 'gemini_unconfigured'
  | 'all_private'
  | 'gemini_failed'
  | 'ollama_unconfigured'
  | 'ollama_failed'

export interface AskCitation {
  /** The `[n]` the answer uses for this passage. */
  n: number
  chunkId: number
  documentId: number
  source: SourceRef
  path: string
  title: string
  headingPath: string
  startLine: number | null
  endLine: number | null
  allowLlm: boolean
  snippet: Snippet
}

export interface AskResponse {
  /** Null when no model answered (engine `retrieval`). */
  answer: string | null
  engine: AskEngine
  /** Model that answered, or null for `retrieval`. */
  model: string | null
  fallbacks: FallbackReason[]
  citations: AskCitation[]
  /** Matching passages kept from Gemini because their document has `allow_llm = false`. */
  withheld: number
  /** True when only full-text search ran (embeddings unavailable). */
  degraded: boolean
}

export interface AskParams {
  question: string
  sources?: SourceKind[]
  limit?: number
}

export async function askQuestion(params: AskParams, signal?: AbortSignal): Promise<AskResponse> {
  const res = await apiFetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  })
  const response = (await res.json()) as AskResponse
  // The server recorded the question before answering (R14).
  recentQueriesChanged('ask')
  return response
}

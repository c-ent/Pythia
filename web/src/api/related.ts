import { apiFetch } from './client'
import type { SourceRef } from './search'

// Mirrors `GET /api/documents/:id/related` (RelatedResponse in server/src/search/relatedService.ts).

export type ScoreBand = 'strong' | 'medium' | 'weak'

export interface RelatedPassage {
  chunkId: number
  headingPath: string
  startLine: number | null
  endLine: number | null
  /** Plain text, capped by the server (400 characters); never HTML. */
  text: string
  truncated: boolean
}

export interface RelatedDocument {
  documentId: number
  source: SourceRef
  path: string
  title: string
  allowLlm: boolean
  /** Cosine similarity of the two document vectors, 0 to 1. */
  score: number
  band: ScoreBand
  /** The neighbour's passage closest to the opened document: the reason for the link. */
  passage: RelatedPassage | null
}

export interface RelatedResponse {
  documentId: number
  /** False for a document outside the map (repo code, boilerplate, no stored chunks). */
  inMap: boolean
  related: RelatedDocument[]
}

export async function getRelated(id: number, signal?: AbortSignal): Promise<RelatedResponse> {
  const res = await apiFetch(`/api/documents/${id}/related`, { signal })
  return (await res.json()) as RelatedResponse
}

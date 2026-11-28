import { NEIGHBOUR_CUTOFF, MAX_NEIGHBOURS, type RelatedHit, type RelatedStore } from '../db/neighbourStore.js'
import type { SearchableKind } from '../db/searchStore.js'
import { capText, type SourceRef } from './searchService.js'

/**
 * Related documents (R20, T66): the semantic neighbours of one map document,
 * read from stored vectors only, so the Related panel never waits on Ollama.
 * Shared by REST and, from T74, the `/mcp` tool `related_documents`.
 */

/** Longest passage text returned per neighbour; the panel shows a short reason, not the document. */
export const MAX_PASSAGE_CHARS = 400

/**
 * Score bands shown instead of raw cosine similarity. Builder choice
 * (2026-11-27), tuned with the cut-off in T67b: strong from 0.8, medium from
 * 0.7, weak from the cut-off (0.6) up.
 */
export const BAND_STRONG = 0.8
export const BAND_MEDIUM = 0.7

export type ScoreBand = 'strong' | 'medium' | 'weak'

export const scoreBand = (score: number): ScoreBand =>
  score >= BAND_STRONG ? 'strong' : score >= BAND_MEDIUM ? 'medium' : 'weak'

export interface RelatedRequest {
  documentId: number
  sources?: readonly SearchableKind[]
  repo?: string
  limit?: number
}

export interface RelatedPassage {
  chunkId: number
  headingPath: string
  startLine: number | null
  endLine: number | null
  /** Plain text, at most `MAX_PASSAGE_CHARS`. */
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
  /** False for a document outside the map (repo code, boilerplate, no stored chunks): it never has neighbours. */
  inMap: boolean
  related: RelatedDocument[]
}

export interface RelatedService {
  /** Null when the document does not exist or is not visible. */
  related(request: RelatedRequest): Promise<RelatedResponse | null>
}

export interface RelatedServiceOptions {
  store: RelatedStore
  cutoff?: number
}

const toDocument = (hit: RelatedHit): RelatedDocument => {
  const passage =
    hit.passage === null
      ? null
      : (() => {
          const capped = capText(hit.passage.content.trim(), MAX_PASSAGE_CHARS)
          return {
            chunkId: hit.passage.chunkId,
            headingPath: hit.passage.headingPath,
            startLine: hit.passage.startLine,
            endLine: hit.passage.endLine,
            text: capped.text,
            truncated: capped.truncated,
          }
        })()
  return {
    documentId: hit.documentId,
    source: { kind: hit.sourceKind, name: hit.sourceName },
    path: hit.path,
    title: hit.title,
    allowLlm: hit.allowLlm,
    score: hit.score,
    band: scoreBand(hit.score),
    passage,
  }
}

export function createRelatedService(options: RelatedServiceOptions): RelatedService {
  const cutoff = options.cutoff ?? NEIGHBOUR_CUTOFF
  return {
    async related(request) {
      const limit = Math.min(MAX_NEIGHBOURS, Math.max(1, Math.trunc(request.limit ?? MAX_NEIGHBOURS)))
      const lookup = await options.store.related({
        documentId: request.documentId,
        filters: { sources: request.sources, repo: request.repo },
        limit,
        cutoff,
      })
      if (lookup === null) return null
      return { documentId: request.documentId, inMap: lookup.inMap, related: lookup.hits.map(toDocument) }
    },
  }
}

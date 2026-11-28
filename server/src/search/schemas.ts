import { z } from 'zod'
import { MAX_ASK_PASSAGES } from '../ask/askService.js'
import { MAX_NEIGHBOURS } from '../db/neighbourStore.js'
import { SEARCHABLE_KINDS } from '../db/searchStore.js'
import { MAX_BACKLINKS } from './backlinkService.js'
import { MAX_SEARCH_LIMIT } from './searchService.js'

// Input schemas shared by the REST routes and the `/mcp` tools, so both
// transports accept exactly the same requests.

export const MAX_QUERY_CHARS = 1000
export const MAX_RECENT_DAYS = 365
export const MAX_RECENT_LIMIT = 200

export const sourceKindSchema = z.enum(SEARCHABLE_KINDS)

export const searchInputSchema = z.object({
  query: z.string().trim().min(1, 'query must not be empty').max(MAX_QUERY_CHARS),
  sources: z.array(sourceKindSchema).min(1).max(SEARCHABLE_KINDS.length).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
})

export const askInputSchema = z.object({
  question: z.string().trim().min(1, 'question must not be empty').max(MAX_QUERY_CHARS),
  sources: z.array(sourceKindSchema).min(1).max(SEARCHABLE_KINDS.length).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(MAX_ASK_PASSAGES).optional(),
})

export const documentLookupSchema = z.object({
  source: sourceKindSchema,
  name: z.string().trim().min(1).max(200).optional(),
  path: z.string().min(1).max(1024),
})

export const repoOverviewSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty').max(200),
})

/**
 * Related documents (R20, T66). Query string form: `sources` is a
 * comma-separated list of kinds (`?sources=keep,gdrive`), like the other GET
 * filters; `limit` is at most the 8 stored neighbours.
 */
export const topicMapInputSchema = z.object({
  topic: z.string().trim().min(1, 'topic must not be empty').max(MAX_QUERY_CHARS),
  sources: z.array(sourceKindSchema).min(1).max(SEARCHABLE_KINDS.length).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
})

export const relatedInputSchema = z.object({
  sources: z
    .string()
    .max(200)
    .transform((value) => value.split(',').map((kind) => kind.trim()).filter((kind) => kind.length > 0))
    .pipe(z.array(sourceKindSchema).min(1).max(SEARCHABLE_KINDS.length))
    .optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_NEIGHBOURS).optional(),
})

/**
 * Graphs (R20, T70): the local graph of a document and the whole-vault graph.
 * Same query string filters as related documents, without a limit.
 */
export const graphInputSchema = relatedInputSchema.omit({ limit: true })

/** Backlinks (R20, T68c): `limit` caps the linking notes, not the outgoing links. */
export const backlinksInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_BACKLINKS).optional(),
})

export const recentInputSchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_RECENT_DAYS).default(7),
  source: sourceKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RECENT_LIMIT).default(50),
})

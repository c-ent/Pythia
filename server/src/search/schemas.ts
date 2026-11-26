import { z } from 'zod'
import { MAX_ASK_PASSAGES } from '../ask/askService.js'
import { SEARCHABLE_KINDS } from '../db/searchStore.js'
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

export const recentInputSchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_RECENT_DAYS).default(7),
  source: sourceKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RECENT_LIMIT).default(50),
})

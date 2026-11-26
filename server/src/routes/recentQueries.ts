import express, { type Router } from 'express'
import { z } from 'zod'
import { MAX_RECENT_QUERIES, RECENT_QUERY_KINDS, type RecentQueryService } from '../recent/recentQueryService.js'
import { HttpError, parseInput } from './api.js'

const kindSchema = z.enum(RECENT_QUERY_KINDS)
const listSchema = z.object({
  kind: kindSchema,
  limit: z.coerce.number().int().min(1).max(MAX_RECENT_QUERIES).optional(),
})
const clearSchema = z.object({ kind: kindSchema })
const idSchema = z.string().regex(/^[1-9]\d{0,15}$/, 'id must be a positive integer')

/**
 * `GET /api/recent-queries?kind=`, `DELETE /api/recent-queries/:id` and
 * `DELETE /api/recent-queries?kind=` (R14). Entries are recorded by
 * `/api/search` and `/api/ask` (routes/api.ts). Mounted after `requireSession`.
 */
export function createRecentQueriesRouter(recent: RecentQueryService): Router {
  const router = express.Router()
  router.use('/recent-queries', (_req, res, next) => {
    // The list holds the owner's query text.
    res.set('cache-control', 'no-store')
    next()
  })

  router.get('/recent-queries', async (req, res) => {
    const input = parseInput(listSchema, req.query)
    const queries = await recent.list(input.kind, input.limit)
    res.json({
      queries: queries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        query: entry.query,
        filters: entry.filters,
        at: entry.at.toISOString(),
      })),
    })
  })

  router.delete('/recent-queries/:id', async (req, res) => {
    const id = Number(parseInput(idSchema, req.params.id))
    if (!(await recent.remove(id))) throw new HttpError(404, 'not_found', 'No such recent query')
    res.status(204).end()
  })

  router.delete('/recent-queries', async (req, res) => {
    const input = parseInput(clearSchema, req.query)
    await recent.clear(input.kind)
    res.status(204).end()
  })

  return router
}

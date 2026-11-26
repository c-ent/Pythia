import express, { type ErrorRequestHandler, type Router } from 'express'
import { z } from 'zod'
import type { AskService } from '../ask/askService.js'
import { KeepDisabledError, type ImportService } from '../ingest/importService.js'
import { KeepTakeoutError } from '../ingest/keepTakeout.js'
import { queryFilters, type RecentQueryService } from '../recent/recentQueryService.js'
import type { RepoService } from '../search/repoService.js'
import {
  askInputSchema,
  documentLookupSchema,
  recentInputSchema,
  repoOverviewSchema,
  searchInputSchema,
} from '../search/schemas.js'
import { AmbiguousDocumentError, SearchInputError, type SearchService } from '../search/searchService.js'
import { MAX_SYNC_LIMIT, type SyncService } from '../sync/syncService.js'

/** An error whose status, code and message are safe to send to the client. */
export class HttpError extends Error {
  override name = 'HttpError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const documentIdSchema = z.string().regex(/^[1-9]\d{0,15}$/, 'id must be a positive integer')

export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.map(String).join('.')}: `
  throw new HttpError(400, 'invalid_input', `${where}${issue?.message ?? 'invalid input'}`)
}

const syncInputSchema = z.object({
  since: z.string().regex(/^(0|[1-9]\d{0,15})$/, 'since must be a cursor from an earlier sync').default('0'),
  // Comma-separated names of pinned repos; empty or absent means none.
  repos: z
    .string()
    .max(4000)
    .default('')
    .transform((value) => value.split(',').map((name) => name.trim()).filter((name) => name.length > 0))
    .pipe(z.array(z.string().max(200)).max(100)),
  limit: z.coerce.number().int().min(1).max(MAX_SYNC_LIMIT).optional(),
})

/**
 * Largest Keep Takeout upload. The zip is held in memory while it is read;
 * Takeout puts attachments (photos, recordings) in the same zip, so it can be
 * far larger than the note text it carries.
 */
export const MAX_KEEP_UPLOAD_BYTES = 256 * 1024 * 1024

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']

/** REST transport for the search, ask, sync, repo and import services (R4, R8, R11, R9, R12). Auth sits in front of it (T8). */
export function createApiRouter(
  search: SearchService,
  ask: AskService,
  sync?: SyncService,
  repos?: RepoService,
  imports?: ImportService,
  recent?: RecentQueryService,
): Router {
  const router = express.Router()
  router.use((_req, res, next) => {
    // Responses hold private note text; no browser or proxy cache may keep them.
    res.set('cache-control', 'no-store')
    next()
  })
  router.use(express.json({ limit: '16kb' }))

  router.post('/search', async (req, res) => {
    const input = parseInput(searchInputSchema, req.body)
    const response = await search.search(input)
    // Recorded only once the search has run; `record` never throws (R14).
    await recent?.record('search', input.query, queryFilters(input))
    res.json(response)
  })

  router.post('/ask', async (req, res) => {
    const input = parseInput(askInputSchema, req.body)
    const response = await ask.ask(input)
    await recent?.record('ask', input.question, queryFilters(input))
    res.json(response)
  })

  router.get('/documents/:id', async (req, res) => {
    const id = Number(parseInput(documentIdSchema, req.params.id))
    const doc = await search.getDocument(id)
    if (doc === null) throw new HttpError(404, 'not_found', 'Document not found')
    res.json(doc)
  })

  router.get('/documents', async (req, res) => {
    const input = parseInput(documentLookupSchema, req.query)
    const doc = await search.findDocument(input.source, input.name ?? null, input.path)
    if (doc === null) throw new HttpError(404, 'not_found', 'Document not found')
    res.json(doc)
  })

  router.get('/recent', async (req, res) => {
    const input = parseInput(recentInputSchema, req.query)
    res.json({ documents: await search.recent(input) })
  })

  if (sync !== undefined) {
    router.get('/sync', async (req, res) => {
      const input = parseInput(syncInputSchema, req.query)
      res.json(await sync.changes({ since: Number(input.since), repos: input.repos, limit: input.limit }))
    })
  }

  if (repos !== undefined) {
    router.get('/repos', async (_req, res) => {
      res.json({ repos: await repos.listRepos() })
    })

    router.get('/repos/:name', async (req, res) => {
      const input = parseInput(repoOverviewSchema, { name: req.params.name })
      const overview = await repos.getOverview(input.name)
      if (overview === null) throw new HttpError(404, 'not_found', 'Repo not found')
      res.json(overview)
    })
  }

  if (imports !== undefined) {
    router.post('/import/keep', express.raw({ type: ZIP_TYPES, limit: MAX_KEEP_UPLOAD_BYTES }), async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, 'invalid_takeout', 'Upload a Google Takeout .zip file')
      }
      const body = req.body
      res.json(await imports.importKeep(new Uint8Array(body.buffer, body.byteOffset, body.length)))
    })

    router.get('/index/status', async (_req, res) => {
      res.json(await imports.status())
    })

    router.post('/index/reindex', (_req, res) => {
      res.status(202).json({ reindex: imports.reindex() })
    })
  }

  return router
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof SearchInputError) return new HttpError(400, 'invalid_input', error.message)
  if (error instanceof AmbiguousDocumentError) return new HttpError(409, 'ambiguous_document', error.message)
  if (error instanceof KeepTakeoutError) return new HttpError(400, 'invalid_takeout', error.message)
  if (error instanceof KeepDisabledError) return new HttpError(409, 'keep_disabled', error.message)
  // `express.json` errors carry a `type` and a 4xx status.
  if (error !== null && typeof error === 'object' && 'type' in error && 'status' in error) {
    if (error.type === 'entity.parse.failed') return new HttpError(400, 'invalid_json', 'Request body is not valid JSON')
    if (error.type === 'entity.too.large') return new HttpError(413, 'payload_too_large', 'Request body is too large')
    if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
      return new HttpError(error.status, 'bad_request', 'Bad request')
    }
  }
  return new HttpError(500, 'internal', 'Internal server error')
}

/** Last middleware: every error becomes `{ error: { code, message } }`, never a stack or DB message. */
export const jsonErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }
  const http = toHttpError(error)
  if (http.status >= 500) {
    // Name and SQLSTATE only: messages can quote note text or query values.
    const name = error instanceof Error ? error.name : 'unknown'
    const code = error !== null && typeof error === 'object' && 'code' in error ? ` ${String(error.code)}` : ''
    console.error(`request failed: ${name}${code}`)
  }
  res.status(http.status).json({ error: { code: http.code, message: http.message } })
}

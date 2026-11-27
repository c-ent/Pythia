import express, { type Router } from 'express'
import { repoOverviewSchema } from '../search/schemas.js'
import type { ActivityEvent } from '../sync/activity.js'
import type { ServerStatus, StatusService } from '../sync/statusService.js'
import type { SyncNowService } from '../sync/syncNow.js'
import { HttpError, parseInput } from './api.js'

const iso = (date: Date | null): string | null => date?.toISOString() ?? null

export function activityJson(event: ActivityEvent) {
  return {
    id: event.id,
    at: event.at.toISOString(),
    kind: event.kind,
    source: event.source,
    count: event.count,
    message: event.message,
  }
}

export function statusJson(status: ServerStatus) {
  return {
    reachable: status.reachable,
    checkedAt: status.checkedAt.toISOString(),
    gemini: status.gemini,
    devices: status.devices,
    documents: status.documents,
    syncing: status.syncing,
    sources: status.sources.map((source) => ({ ...source, lastSyncAt: iso(source.lastSyncAt) })),
    repos: status.repos.map((repo) => ({ ...repo, lastSyncAt: iso(repo.lastSyncAt) })),
    activity: status.activity.map(activityJson),
  }
}

/**
 * Status, Sync now and per-repo re-sync (R18, T42): `GET /api/status`,
 * `GET /api/activity`, `POST /api/sync-now` and `POST /api/repos/:name/sync`.
 * Both POSTs answer 202 at once; the work runs in the background. Mounted
 * after `requireSession`; errors go to `jsonErrorHandler`.
 */
export function createStatusRouter(status: StatusService, sync: SyncNowService): Router {
  const router = express.Router()
  const noStore: express.RequestHandler = (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  }
  router.use(['/status', '/activity', '/sync-now', '/repos/:name/sync'], noStore)

  router.get('/status', async (_req, res) => {
    res.json(statusJson(await status.status()))
  })

  router.get('/activity', async (_req, res) => {
    res.json({ activity: (await status.activity()).map(activityJson) })
  })

  router.post('/sync-now', (_req, res) => {
    res.status(202).json(sync.syncNow())
  })

  router.post('/repos/:name/sync', (req, res) => {
    const { name } = parseInput(repoOverviewSchema, { name: req.params.name })
    const state = sync.syncRepo(name)
    if (state === 'off') throw new HttpError(409, 'repos_off', 'Repo fetching is off on this server')
    if (state === 'not_found') throw new HttpError(404, 'not_found', 'Repo not found')
    res.status(202).json({ name, started: state === 'started', state })
  })

  return router
}

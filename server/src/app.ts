import express, { type Express } from 'express'
import type { AskService } from './ask/askService.js'
import type { ImportService } from './ingest/importService.js'
import { createMcpRouter } from './mcp/mcpServer.js'
import { createApiRouter, jsonErrorHandler } from './routes/api.js'
import { createAuthRouter, requireBearer, requireSession, type AuthDeps } from './routes/auth.js'
import type { ProfileService } from './profile/profileService.js'
import { createProfileRouter } from './routes/profile.js'
import type { RecentQueryService } from './recent/recentQueryService.js'
import { createRecentQueriesRouter } from './routes/recentQueries.js'
import { createSettingsRouter } from './routes/settings.js'
import { createStaticRouter } from './routes/static.js'
import type { RepoService } from './search/repoService.js'
import type { SearchService } from './search/searchService.js'
import type { SettingsService } from './settings/settingsService.js'
import type { SyncService } from './sync/syncService.js'

export interface AppDeps {
  search: SearchService
  ask: AskService
  auth: AuthDeps
  /** Offline sync (R11); `/api/sync` answers 404 without it. */
  sync?: SyncService
  /** Repo list and overviews (R9); `/api/repos` and the repo MCP tools exist only with it. */
  repos?: RepoService
  /** Keep import, index status and re-index (R12); those routes exist only with it. */
  imports?: ImportService
  /** Settings, starting with the Gemini exclusion list (R3); `/api/settings` exists only with it. */
  settings?: SettingsService
  /** Profile and preferences (R17); `/api/profile` exists only with it. */
  profile?: ProfileService
  /** Recent searches and questions (R14); `/api/recent-queries` exists only with it, and search and ask record into it. */
  recent?: RecentQueryService
  /** Built PWA directory (T18); without it only the API, `/mcp` and `/healthz` are served. */
  webDir?: string
}

/** The Express app without `listen`, so tests can start it on a random port. */
export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' })
  })
  // Login, logout and session status are the only /api routes open without a
  // session; everything after `requireSession` answers 401 without one.
  app.use('/api', createAuthRouter(deps.auth))
  app.use('/api', requireSession(deps.auth))
  if (deps.settings !== undefined) app.use('/api', createSettingsRouter(deps.settings))
  if (deps.profile !== undefined) app.use('/api', createProfileRouter(deps.profile))
  if (deps.recent !== undefined) app.use('/api', createRecentQueriesRouter(deps.recent))
  app.use('/api', createApiRouter(deps.search, deps.ask, deps.sync, deps.repos, deps.imports, deps.recent))
  // The MCP server (R7) has its own static bearer token, separate from login.
  app.use('/mcp', requireBearer(deps.auth.mcpToken), createMcpRouter(deps.search, console.error, deps.repos))
  // The app shell is public: it has to load before the login screen can show.
  // It never answers /api, /mcp or /healthz paths (see routes/static.ts).
  if (deps.webDir !== undefined) app.use(createStaticRouter(deps.webDir))
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } })
  })
  app.use(jsonErrorHandler)
  return app
}

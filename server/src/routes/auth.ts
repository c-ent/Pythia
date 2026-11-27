import express, { type CookieOptions, type RequestHandler, type Response, type Router } from 'express'
import { z } from 'zod'
import { parsePasswordHash, verifyPassword, type PasswordHash } from '../security/password.js'
import { createVisitorLimiter, visitorKey, type VisitorLimiter } from '../security/rateLimit.js'
import { createSessionManager, type Session, type SessionManager, type SessionStore } from '../security/sessionStore.js'
import { createMcpTokenService, type McpTokenService, type McpTokenStore } from '../mcp/mcpToken.js'
import { requestOrigin } from '../security/tailnet.js'
import { HttpError } from './api.js'

// `__Host-` makes browsers require Secure and Path=/ and refuse a Domain, so
// no other site or subdomain can set or overwrite it.
export const SESSION_COOKIE = '__Host-pythia_session'

// 10 attempts per 15 minutes per visitor (see `visitorKey`).
export const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 }

export const sessionCookieOptions: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }

const loginSchema = z.object({ password: z.string().min(1).max(1024) })

export interface LoginDeps {
  password: PasswordHash
  sessions: SessionManager
  limiter: VisitorLimiter
}

export interface AuthDeps {
  /** null when no password hash is configured: login answers 503 and `/api` 401. */
  login: LoginDeps | null
  /** The `/mcp` bearer token: `.env` until the first rotation, then the database (T37). */
  mcp: McpTokenService
}

export interface AuthSettings {
  passwordHash: string | null
  /** PYTHIA_MCP_TOKEN; used until the token is rotated. */
  mcpToken: string | null
  /** Where web sessions live (the `sessions` table in production). */
  sessionStore: SessionStore
  /** Where a rotated MCP token's hash lives (the `mcp_token` table in production). */
  mcpTokenStore: McpTokenStore
}

/** Builds auth from config. A missing value turns a feature off; it never opens it. */
export function createAuthDeps(settings: AuthSettings, log: (line: string) => void = console.log): AuthDeps {
  let login: LoginDeps | null = null
  if (settings.passwordHash === null) {
    log('PYTHIA_PASSWORD_HASH is not set; web login is off and /api answers 401')
  } else {
    const password = parsePasswordHash(settings.passwordHash)
    if (password === null) throw new Error('PYTHIA_PASSWORD_HASH is not a valid argon2id hash')
    login = {
      password,
      sessions: createSessionManager({ store: settings.sessionStore, passwordHash: settings.passwordHash }),
      limiter: createVisitorLimiter(LOGIN_LIMIT),
    }
  }
  if (settings.mcpToken === null) log('PYTHIA_MCP_TOKEN is not set; /mcp answers 401 until a token is rotated in Settings')
  return { login, mcp: createMcpTokenService({ envToken: settings.mcpToken, store: settings.mcpTokenStore }) }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

async function findSession(deps: AuthDeps, cookieHeader: string | undefined): Promise<Session | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE)
  if (token === null || deps.login === null) return null
  return deps.login.sessions.verify(token)
}

const CURRENT_SESSION = 'pythiaSession'

/** The session `requireSession` let through, for routes that need to know the current device. */
export function currentSession(res: Response): Session | null {
  return (res.locals[CURRENT_SESSION] as Session | undefined) ?? null
}

export const unauthenticated = (): HttpError => new HttpError(401, 'unauthenticated', 'Sign in required')

/** `POST /login`, `POST /logout` and `GET /session`; mounted on `/api` in front of `requireSession`. */
export function createAuthRouter(deps: AuthDeps): Router {
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })

  router.post('/login', express.json({ limit: '4kb' }), async (req, res) => {
    const login = deps.login
    if (login === null) throw new HttpError(503, 'auth_not_configured', 'Login is not set up on this server')
    // The slot is taken before the hash is checked, so parallel guesses count too.
    const visitor = visitorKey(req.headers['x-forwarded-for'])
    const slot = login.limiter.take(visitor)
    if (!slot.allowed) {
      res.set('retry-after', String(slot.retryAfterSeconds))
      throw new HttpError(429, 'rate_limited', 'Too many login attempts; try again later')
    }
    const input = loginSchema.safeParse(req.body)
    if (!input.success) throw new HttpError(400, 'invalid_input', 'password: a password is required')
    if (!(await verifyPassword(input.data.password, login.password))) {
      throw new HttpError(401, 'invalid_credentials', 'Wrong password')
    }
    login.limiter.reset(visitor)
    const session = await login.sessions.issue(req.headers['user-agent'])
    res.cookie(SESSION_COOKIE, session.token, { ...sessionCookieOptions, maxAge: session.maxAgeMs })
    res.status(204).end()
  })

  router.post('/logout', async (req, res) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (token !== null) await deps.login?.sessions.revoke(token)
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions)
    res.status(204).end()
  })

  // The web app asks this on every load. Signed out is a normal answer here
  // (200, `authenticated: false`), not a 401, so the browser does not log an
  // error each time the login screen opens. It grants nothing: every other
  // `/api` route still answers 401 without a session.
  router.get('/session', async (req, res) => {
    res.json({ authenticated: (await findSession(deps, req.headers.cookie)) !== null })
  })

  return router
}

/** 401 unless the request carries the cookie of an active session. */
export function requireSession(deps: AuthDeps): RequestHandler {
  return async (req, res, next) => {
    const session = await findSession(deps, req.headers.cookie)
    if (session === null) {
      next(unauthenticated())
      return
    }
    res.locals[CURRENT_SESSION] = session
    next()
  }
}

/**
 * 403 `tailnet_only` unless the request came over the tailnet or from the host
 * itself (R7, T48); see `requestOrigin`. Mounted in front of `requireBearer`, so
 * Funnel traffic is refused before the token is looked at and a leaked token is
 * useless outside the owner's tailnet.
 */
export function requireTailnet(): RequestHandler {
  return (req, _res, next) => {
    const origin = requestOrigin(req.headers, req.socket.remoteAddress)
    if (origin === 'tailnet' || origin === 'host') {
      next()
      return
    }
    next(new HttpError(403, 'tailnet_only', '/mcp is only available over Tailscale'))
  }
}

/**
 * 401 unless `Authorization: Bearer <token>` is the MCP token in use, compared
 * in constant time. Checked on every request, so a rotation applies at once.
 */
export function requireBearer(mcp: McpTokenService): RequestHandler {
  return async (req, res, next) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    if (match !== null && (await mcp.verify(match[1] ?? ''))) {
      next()
      return
    }
    res.set('www-authenticate', 'Bearer')
    next(new HttpError(401, 'unauthenticated', 'A valid bearer token is required'))
  }
}

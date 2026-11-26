import express, { type CookieOptions, type RequestHandler, type Router } from 'express'
import { z } from 'zod'
import { parsePasswordHash, verifyPassword, type PasswordHash } from '../security/password.js'
import { createVisitorLimiter, visitorKey, type VisitorLimiter } from '../security/rateLimit.js'
import { createSessionSigner, type SessionSigner } from '../security/session.js'
import { randomSecret, secretsEqual } from '../security/tokens.js'
import { HttpError } from './api.js'

// `__Host-` makes browsers require Secure and Path=/ and refuse a Domain, so
// no other site or subdomain can set or overwrite it.
export const SESSION_COOKIE = '__Host-pythia_session'

// 10 attempts per 15 minutes per visitor (see `visitorKey`).
export const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 }

const cookieOptions: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }

const loginSchema = z.object({ password: z.string().min(1).max(1024) })

export interface LoginDeps {
  password: PasswordHash
  sessions: SessionSigner
  limiter: VisitorLimiter
}

export interface AuthDeps {
  /** null when no password hash is configured: login answers 503 and `/api` 401. */
  login: LoginDeps | null
  /** null when no MCP token is configured: `/mcp` answers 401. */
  mcpToken: string | null
}

export interface AuthSettings {
  passwordHash: string | null
  sessionSecret: string | null
  mcpToken: string | null
}

/** Builds auth from config. A missing value turns a feature off; it never opens it. */
export function createAuthDeps(settings: AuthSettings, log: (line: string) => void = console.log): AuthDeps {
  let login: LoginDeps | null = null
  if (settings.passwordHash === null) {
    log('PYTHIA_PASSWORD_HASH is not set; web login is off and /api answers 401')
  } else {
    const password = parsePasswordHash(settings.passwordHash)
    if (password === null) throw new Error('PYTHIA_PASSWORD_HASH is not a valid argon2id hash')
    if (settings.sessionSecret === null) log('PYTHIA_SESSION_SECRET is not set; sessions end when the server restarts')
    login = {
      password,
      sessions: createSessionSigner({ secret: settings.sessionSecret ?? randomSecret(), passwordHash: settings.passwordHash }),
      limiter: createVisitorLimiter(LOGIN_LIMIT),
    }
  }
  if (settings.mcpToken === null) log('PYTHIA_MCP_TOKEN is not set; /mcp answers 401')
  return { login, mcpToken: settings.mcpToken }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function hasSession(deps: AuthDeps, cookieHeader: string | undefined): boolean {
  const token = readCookie(cookieHeader, SESSION_COOKIE)
  return token !== null && deps.login !== null && deps.login.sessions.verify(token)
}

const unauthenticated = (): HttpError => new HttpError(401, 'unauthenticated', 'Sign in required')

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
    const session = login.sessions.issue()
    res.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: session.maxAgeMs })
    res.status(204).end()
  })

  router.post('/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (token !== null) deps.login?.sessions.revoke(token)
    res.clearCookie(SESSION_COOKIE, cookieOptions)
    res.status(204).end()
  })

  router.get('/session', (req, res) => {
    if (!hasSession(deps, req.headers.cookie)) throw unauthenticated()
    res.json({ authenticated: true })
  })

  return router
}

/** 401 unless the request carries a valid session cookie. */
export function requireSession(deps: AuthDeps): RequestHandler {
  return (req, _res, next) => {
    if (hasSession(deps, req.headers.cookie)) next()
    else next(unauthenticated())
  }
}

/** 401 unless `Authorization: Bearer <token>` matches, compared in constant time. */
export function requireBearer(token: string | null): RequestHandler {
  return (req, res, next) => {
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')
    if (token !== null && match !== null && secretsEqual(match[1] ?? '', token)) {
      next()
      return
    }
    res.set('www-authenticate', 'Bearer')
    next(new HttpError(401, 'unauthenticated', 'A valid bearer token is required'))
  }
}

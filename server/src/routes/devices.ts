import express, { type Router } from 'express'
import { z } from 'zod'
import { MAX_DEVICE_NAME } from '../security/session.js'
import type { Session, SessionManager } from '../security/sessionStore.js'
import { HttpError, parseInput } from './api.js'
import { currentSession, SESSION_COOKIE, sessionCookieOptions } from './auth.js'

const idSchema = z.string().regex(/^[1-9]\d{0,15}$/, 'id must be a positive integer')
const renameSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(MAX_DEVICE_NAME, `name must be at most ${MAX_DEVICE_NAME} characters`),
})

const noDevice = (): HttpError => new HttpError(404, 'not_found', 'No such signed-in device')

function deviceView(session: Session, current: Session | null) {
  return {
    id: session.id,
    name: session.deviceName,
    userAgent: session.userAgent,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: current?.id === session.id,
  }
}

/**
 * Signed-in devices (R15, T36): `GET /api/devices`, `PATCH /api/devices/:id`
 * (rename), `DELETE /api/devices/:id` (sign out one) and
 * `POST /api/devices/sign-out-all`. Mounted after `requireSession`.
 */
export function createDevicesRouter(sessions: SessionManager): Router {
  const router = express.Router()
  router.use('/devices', (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })

  router.get('/devices', async (_req, res) => {
    const current = currentSession(res)
    const devices = await sessions.list()
    res.json({ devices: devices.map((session) => deviceView(session, current)) })
  })

  router.post('/devices/sign-out-all', async (_req, res) => {
    await sessions.revokeAll()
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions)
    res.status(204).end()
  })

  router.patch('/devices/:id', express.json({ limit: '4kb' }), async (req, res) => {
    const id = Number(parseInput(idSchema, req.params.id))
    const input = parseInput(renameSchema, req.body)
    const session = await sessions.rename(id, input.name)
    if (session === null) throw noDevice()
    res.json({ device: deviceView(session, currentSession(res)) })
  })

  router.delete('/devices/:id', async (req, res) => {
    const id = Number(parseInput(idSchema, req.params.id))
    if (!(await sessions.revokeDevice(id))) throw noDevice()
    // Signing out this device from its own list works like logout.
    if (currentSession(res)?.id === id) res.clearCookie(SESSION_COOKIE, sessionCookieOptions)
    res.status(204).end()
  })

  return router
}

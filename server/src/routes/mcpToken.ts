import express, { type Router } from 'express'
import type { McpTokenService } from '../mcp/mcpToken.js'

/**
 * `GET /api/mcp-token` (source and last 4 characters) and
 * `POST /api/mcp-token/rotate` (T37). The new token is only in the rotate
 * response. Mounted after `requireSession`.
 */
export function createMcpTokenRouter(mcp: McpTokenService): Router {
  const router = express.Router()
  router.use('/mcp-token', (_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })

  router.get('/mcp-token', async (_req, res) => {
    const status = await mcp.status()
    res.json({ source: status.source, last4: status.last4, rotatedAt: status.rotatedAt?.toISOString() ?? null })
  })

  router.post('/mcp-token/rotate', async (_req, res) => {
    const rotated = await mcp.rotate()
    res.json({ token: rotated.token, last4: rotated.last4, rotatedAt: rotated.rotatedAt.toISOString() })
  })

  return router
}

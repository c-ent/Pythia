import path from 'node:path'
import express, { type Router } from 'express'

/** Paths the app shell never answers: they belong to the API, MCP and the health check. */
const NOT_SHELL = /^\/(?:api|mcp|healthz)(?:\/|$)/

// Files that keep their name between builds must be revalidated, or a phone
// keeps running an old service worker or shell. Vite's hashed assets never change.
const REVALIDATE = new Set(['/index.html', '/sw.js', '/registerSW.js', '/manifest.webmanifest'])

/**
 * Serves the built PWA (`web/dist`) from the same origin as `/api` and `/mcp`
 * (D1), so the session cookie and the service worker scope cover both. Other
 * GET paths without a file extension get `index.html`, so a reload on a deep
 * link reaches the client router. No session is needed: the shell has to load
 * before the login screen can show.
 */
export function createStaticRouter(dir: string): Router {
  const root = path.resolve(dir)
  const index = path.join(root, 'index.html')
  const router = express.Router()

  router.use((req, res, next) => {
    if (!NOT_SHELL.test(req.path)) res.setHeader('x-content-type-options', 'nosniff')
    next()
  })

  router.use(
    express.static(root, {
      index: false,
      dotfiles: 'ignore',
      redirect: false,
      setHeaders(res, filePath) {
        const rel = `/${path.relative(root, filePath).split(path.sep).join('/')}`
        if (rel.startsWith('/assets/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable')
        else if (REVALIDATE.has(rel)) res.setHeader('cache-control', 'no-cache')
        else res.setHeader('cache-control', 'public, max-age=3600')
      },
    }),
  )

  router.use((req, res, next) => {
    const isPage =
      (req.method === 'GET' || req.method === 'HEAD') && !NOT_SHELL.test(req.path) && path.extname(req.path) === ''
    if (!isPage) {
      next()
      return
    }
    res.setHeader('cache-control', 'no-cache')
    res.sendFile(index, (error) => {
      if (error) next(error)
    })
  })

  return router
}

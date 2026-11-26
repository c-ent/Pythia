import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStaticRouter } from './static.js'

const SHELL = '<!doctype html><title>pythia shell</title>'

let dir: string
let server: Server
let base: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'pythia-web-'))
  await mkdir(path.join(dir, 'assets'))
  await writeFile(path.join(dir, 'index.html'), SHELL)
  await writeFile(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  await writeFile(path.join(dir, 'sw.js'), 'self.version = 1')
  await writeFile(path.join(dir, 'pwa-192.png'), 'png')
  // Built from parts so no literal secret-looking line sits in the repo.
  await writeFile(path.join(dir, '.env'), ['SECRET', 'leaked'].join('='))

  const app = express()
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true })
  })
  app.use(createStaticRouter(dir))
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found' } })
  })
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

describe('createStaticRouter', () => {
  it('serves the shell at / and on deep links, revalidated every time', async () => {
    for (const url of ['/', '/repos', '/settings/storage']) {
      const res = await fetch(base + url)
      expect(res.status, url).toBe(200)
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe(SHELL)
    }
  })

  it('caches hashed assets for good and revalidates the service worker', async () => {
    const asset = await fetch(`${base}/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await asset.text()).toBe('console.log(1)')

    const sw = await fetch(`${base}/sw.js`)
    expect(sw.headers.get('cache-control')).toBe('no-cache')
    const icon = await fetch(`${base}/pwa-192.png`)
    expect(icon.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  it('never answers API, MCP or health paths with the shell', async () => {
    expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({ ok: true })
    for (const url of ['/api', '/api/unknown', '/mcp', '/mcp/x', '/healthz/x']) {
      const res = await fetch(base + url)
      expect(res.status, url).toBe(404)
      expect(await res.text()).not.toContain('pythia shell')
    }
  })

  it('answers 404 for missing files and non-GET requests', async () => {
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${base}/repos`, { method: 'POST' })).status).toBe(404)
  })

  it('never serves dotfiles', async () => {
    const res = await fetch(`${base}/.env`)
    expect(await res.text()).not.toContain('leaked')
  })
})

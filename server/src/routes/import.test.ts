import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import { KeepDisabledError, type ImportService } from '../ingest/importService.js'
import { KeepTakeoutError, parseKeepTakeout } from '../ingest/keepTakeout.js'
import { keepJson, takeoutZip } from '../ingest/testKeepTakeout.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createSessionSigner } from '../security/session.js'
import type { SearchService } from '../search/searchService.js'
import { SESSION_COOKIE, type AuthDeps } from './auth.js'

const sessions = createSessionSigner({ secret: 'r'.repeat(32), passwordHash: 'test-hash' })
const auth: AuthDeps = {
  login: {
    password: { cost: { memory: 1024, passes: 2, parallelism: 1 }, salt: Buffer.alloc(16), key: Buffer.alloc(32) },
    sessions,
    limiter: createVisitorLimiter({ max: 10, windowMs: 60_000 }),
  },
  mcpToken: null,
}
const cookie = `${SESSION_COOKIE}=${sessions.issue().token}`

interface ErrorBody {
  error: { code: string; message: string }
}

const search = {} as SearchService
const ask = {} as AskService

describe('import routes', () => {
  let server: Server
  let base: string
  const uploads: number[] = []
  let disabled = false

  const imports: ImportService = {
    async importKeep(zip) {
      uploads.push(zip.length)
      if (disabled) throw new KeepDisabledError('Keep import is switched off for this server')
      const { notes, skipped } = parseKeepTakeout(zip)
      return { notes: notes.length, indexed: notes.length, unchanged: 0, deleted: 0, failed: 0, skipped }
    },
    async status() {
      return {
        sources: [{ kind: 'keep', name: 'keep', enabled: true, documents: 1, chunks: 1, updatedAt: new Date('2026-11-26T00:00:00Z') }],
        reindex: { vault: 'idle', repos: 'off' },
      }
    },
    reindex() {
      return { vault: 'running', repos: 'off' }
    },
  }

  beforeAll(async () => {
    server = createServer(createApp({ search, ask, auth, imports }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const upload = (body: Uint8Array | string, type = 'application/zip', withCookie = true) =>
    fetch(`${base}/api/import/keep`, {
      method: 'POST',
      headers: { 'content-type': type, ...(withCookie ? { cookie } : {}) },
      body,
    })

  it('imports a Keep Takeout zip', async () => {
    const res = await upload(takeoutZip({ 'a.json': keepJson(), 'b.json': keepJson({ title: 'B' }) }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ notes: 2, indexed: 2, deleted: 0 })
  })

  it('answers 400 with a clear message for a file that is not a Keep export', async () => {
    const notZip = await upload('plain text')
    expect(notZip.status).toBe(400)
    expect(await notZip.json()).toEqual({ error: { code: 'invalid_takeout', message: 'The upload is not a zip file' } })

    const otherProduct = await upload(takeoutZip({ '/Takeout/Drive/x.json': JSON.stringify({ name: 'x' }) }))
    expect(otherProduct.status).toBe(400)
    expect(((await otherProduct.json()) as ErrorBody).error.message).toBe('No Google Keep notes found in this zip')
  })

  it('answers 400 for an empty body or a non-zip content type', async () => {
    expect((await upload(new Uint8Array())).status).toBe(400)
    const before = uploads.length
    const json = await upload('{"a":1}', 'application/json')
    expect(json.status).toBe(400)
    expect(uploads.length).toBe(before)
  })

  it('answers 409 when the Keep source is switched off', async () => {
    disabled = true
    try {
      const res = await upload(takeoutZip({ 'a.json': keepJson() }))
      expect(res.status).toBe(409)
      expect(((await res.json()) as ErrorBody).error.code).toBe('keep_disabled')
    } finally {
      disabled = false
    }
  })

  it('needs a session', async () => {
    expect((await upload(takeoutZip({ 'a.json': keepJson() }), 'application/zip', false)).status).toBe(401)
    expect((await fetch(`${base}/api/index/status`)).status).toBe(401)
    expect((await fetch(`${base}/api/index/reindex`, { method: 'POST' })).status).toBe(401)
  })

  it('reports index status', async () => {
    const res = await fetch(`${base}/api/index/status`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sources: [{ kind: 'keep', name: 'keep', enabled: true, documents: 1, chunks: 1, updatedAt: '2026-11-26T00:00:00.000Z' }],
      reindex: { vault: 'idle', repos: 'off' },
    })
  })

  it('starts a re-index and answers 202', async () => {
    const res = await fetch(`${base}/api/index/reindex`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ reindex: { vault: 'running', repos: 'off' } })
  })

  it('maps a takeout error thrown by the service to 400', async () => {
    const throwing = createServer(
      createApp({
        search,
        ask,
        auth,
        imports: {
          ...imports,
          importKeep: async () => {
            throw new KeepTakeoutError('This Keep export has no notes to import (all are trashed or empty)')
          },
        },
      }),
    )
    await new Promise<void>((resolve) => throwing.listen(0, '127.0.0.1', resolve))
    try {
      const url = `http://127.0.0.1:${(throwing.address() as AddressInfo).port}/api/import/keep`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/zip', cookie },
        body: takeoutZip({ 'a.json': keepJson() }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as ErrorBody).error.code).toBe('invalid_takeout')
    } finally {
      await new Promise((resolve) => throwing.close(resolve))
    }
  })
})

describe('import routes without the service', () => {
  it('are not registered', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const res = await fetch(`${base}/api/index/status`, { headers: { cookie } })
      expect(res.status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

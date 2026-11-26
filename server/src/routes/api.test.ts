import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskRequest, AskService } from '../ask/askService.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createSessionSigner } from '../security/session.js'
import { createMemorySyncStore } from '../sync/memorySyncStore.js'
import { createSyncService } from '../sync/syncService.js'
import type { RepoService } from '../search/repoService.js'
import { SESSION_COOKIE, type AuthDeps } from './auth.js'
import {
  AmbiguousDocumentError,
  type DocumentView,
  type RecentRequest,
  type SearchRequest,
  type SearchService,
} from '../search/searchService.js'

const view: DocumentView = {
  id: 7,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Projects/Pythia.md',
  title: 'Pythia',
  language: null,
  allowLlm: true,
  mtime: null,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  content: '# Goals',
  truncated: false,
  totalChars: 7,
}

// Auth has its own tests (auth.test.ts); here every request carries a valid
// session cookie.
const sessions = createSessionSigner({ secret: 'x'.repeat(40), passwordHash: 'test-hash' })
const auth: AuthDeps = {
  login: {
    password: { cost: { memory: 1024, passes: 2, parallelism: 1 }, salt: Buffer.alloc(16), key: Buffer.alloc(32) },
    sessions,
    limiter: createVisitorLimiter({ max: 10, windowMs: 60_000 }),
  },
  mcpToken: null,
}
const cookie = `${SESSION_COOKIE}=${sessions.issue().token}`
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } })

describe('REST API', () => {
  let server: Server
  let base: string
  const searches: SearchRequest[] = []
  const recents: RecentRequest[] = []

  const service: SearchService = {
    async search(request) {
      searches.push(request)
      if (request.query === 'boom') throw new Error('relation "secret text" does not exist')
      return { results: [], degraded: false }
    },
    async getDocument(id) {
      return id === 7 ? view : null
    },
    async findDocument(kind, _name, path) {
      if (path === 'dup.md') throw new AmbiguousDocumentError('more than one repo source has this path; name the source')
      return kind === 'obsidian' && path === view.path ? view : null
    },
    async recent(request) {
      recents.push(request)
      return [view]
    },
  }

  const asks: AskRequest[] = []
  const askService: AskService = {
    async ask(request) {
      asks.push(request)
      return { answer: 'Yes [1].', engine: 'ollama', model: 'qwen3:4b', fallbacks: ['gemini_unconfigured'], citations: [], withheld: 0, degraded: false }
    },
  }

  const syncStore = createMemorySyncStore()
  syncStore.put({
    id: 7,
    sourceKind: 'obsidian',
    sourceName: 'vault',
    path: 'Projects/Pythia.md',
    title: 'Pythia',
    language: null,
    allowLlm: true,
    mtime: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    chunks: ['# Goals'],
  })
  syncStore.put({
    id: 9,
    sourceKind: 'repo',
    sourceName: 'kitchen-app',
    path: 'src/cart.ts',
    title: 'src/cart.ts',
    language: 'typescript',
    allowLlm: true,
    mtime: null,
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    chunks: ['export {}'],
  })
  const sync = createSyncService({ store: syncStore })

  const repos: RepoService = {
    async listRepos() {
      return [{ name: 'kitchen-app', files: 3, chunks: 9, updatedAt: new Date('2026-11-21T08:00:00Z') }]
    },
    async getOverview(name) {
      if (name === 'boom') throw new Error('relation "secret text" does not exist')
      if (name !== 'kitchen-app') return null
      return {
        name,
        files: 3,
        chunks: 9,
        updatedAt: new Date('2026-11-21T08:00:00Z'),
        summary: { documentId: 30, allowLlm: true, text: 'Repository: kitchen-app' },
      }
    },
  }

  beforeAll(async () => {
    server = createServer(createApp({ search: service, ask: askService, auth, sync, repos }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })

  it('searches with validated input and no caching', async () => {
    const res = await post('/api/search', JSON.stringify({ query: ' goals ', sources: ['obsidian'], limit: 5 }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ results: [], degraded: false })
    expect(searches.at(-1)).toEqual({ query: 'goals', sources: ['obsidian'], limit: 5 })
  })

  it.each([
    ['empty query', { query: '  ' }],
    ['missing query', {}],
    ['unknown source kind', { query: 'x', sources: ['work'] }],
    ['limit above 50', { query: 'x', limit: 51 }],
  ])('returns 400 for %s', async (_name, body) => {
    const res = await post('/api/search', JSON.stringify(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('returns 400 for malformed JSON', async () => {
    const res = await post('/api/search', '{nope')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } })
  })

  it('returns 413 for an oversized body', async () => {
    const res = await post('/api/search', JSON.stringify({ query: 'x'.repeat(20_000) }))
    expect(res.status).toBe(413)
  })

  it('hides internal error details', async () => {
    const res = await post('/api/search', JSON.stringify({ query: 'boom' }))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'internal', message: 'Internal server error' } })
    expect(text).not.toContain('secret')
  })

  it('asks with validated input and no caching', async () => {
    const res = await post('/api/ask', JSON.stringify({ question: ' what are my goals? ', sources: ['obsidian'], limit: 4 }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ answer: 'Yes [1].', engine: 'ollama' })
    expect(asks.at(-1)).toEqual({ question: 'what are my goals?', sources: ['obsidian'], limit: 4 })
  })

  it.each([
    ['empty question', { question: ' ' }],
    ['missing question', { query: 'x' }],
    ['unknown source kind', { question: 'x', sources: ['work'] }],
    ['limit above 10', { question: 'x', limit: 11 }],
  ])('returns 400 for ask with %s', async (_name, body) => {
    const res = await post('/api/ask', JSON.stringify(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('gets a document by id', async () => {
    const res = await fetch(`${base}/api/documents/7`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 7, path: 'Projects/Pythia.md', content: '# Goals' })
  })

  it.each(['abc', '0', '-1', '1.5', '99999999999999999'])('returns 400 for document id %s', async (id) => {
    const res = await fetch(`${base}/api/documents/${id}`)
    expect(res.status).toBe(400)
  })

  it('returns 404 for a missing document', async () => {
    const res = await fetch(`${base}/api/documents/8`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Document not found' } })
  })

  it('gets a document by source and path', async () => {
    const res = await fetch(`${base}/api/documents?source=obsidian&path=${encodeURIComponent(view.path)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 7 })
  })

  it('returns 400 when the lookup has no path, and 409 when it is ambiguous', async () => {
    expect((await fetch(`${base}/api/documents?source=obsidian`)).status).toBe(400)
    const res = await fetch(`${base}/api/documents?source=repo&path=dup.md`)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'ambiguous_document' } })
  })

  it('lists recent documents with defaults and parsed query values', async () => {
    const res = await fetch(`${base}/api/recent`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ documents: [{ id: 7 }] })
    expect(recents.at(-1)).toEqual({ days: 7, limit: 50 })

    await fetch(`${base}/api/recent?days=3&source=keep&limit=5`)
    expect(recents.at(-1)).toEqual({ days: 3, source: 'keep', limit: 5 })
  })

  it.each(['days=0', 'days=abc', 'days=400', 'source=work', 'limit=1000'])('returns 400 for recent %s', async (q) => {
    expect((await fetch(`${base}/api/recent?${q}`)).status).toBe(400)
  })

  it('syncs everything from cursor 0, with no caching', async () => {
    const res = await fetch(`${base}/api/sync`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { cursor: string; hasMore: boolean; documents: Array<{ id: number; content: string }>; deleted: number[] }
    expect(body).toMatchObject({ cursor: '2', hasMore: false, reset: false, deleted: [9] })
    expect(body.documents.map((doc) => [doc.id, doc.content])).toEqual([[7, '# Goals']])
  })

  it('sends pinned repo files and nothing new after the cursor', async () => {
    const pinned = (await (await fetch(`${base}/api/sync?since=0&repos=kitchen-app,%20other`)).json()) as {
      documents: Array<{ id: number }>
    }
    expect(pinned.documents.map((doc) => doc.id)).toEqual([7, 9])
    const after = await (await fetch(`${base}/api/sync?since=2`)).json()
    expect(after).toEqual({ cursor: '2', hasMore: false, reset: false, documents: [], deleted: [] })
  })

  it('pages with a limit', async () => {
    const first = (await (await fetch(`${base}/api/sync?since=0&limit=1`)).json()) as { cursor: string; hasMore: boolean }
    expect(first).toMatchObject({ cursor: '1', hasMore: true })
  })

  it.each(['since=-1', 'since=abc', 'since=1.5', 'since=01', 'limit=0', 'limit=100000', `repos=${'x'.repeat(300)}`])(
    'returns 400 for sync %s',
    async (q) => {
      const res = await fetch(`${base}/api/sync?${q}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
    },
  )

  it('lists repos and returns one overview', async () => {
    const list = await fetch(`${base}/api/repos`)
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('no-store')
    expect(await list.json()).toEqual({
      repos: [{ name: 'kitchen-app', files: 3, chunks: 9, updatedAt: '2026-11-21T08:00:00.000Z' }],
    })

    const one = await fetch(`${base}/api/repos/kitchen-app`)
    expect(one.status).toBe(200)
    expect(await one.json()).toMatchObject({ name: 'kitchen-app', summary: { documentId: 30, text: 'Repository: kitchen-app' } })
  })

  it('answers 404 for an unknown repo and hides internal errors', async () => {
    const missing = await fetch(`${base}/api/repos/nope`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'Repo not found' } })

    const failed = await fetch(`${base}/api/repos/boom`)
    expect(failed.status).toBe(500)
    expect(JSON.stringify(await failed.json())).not.toContain('secret')
  })

  it('returns JSON 404 for unknown routes and keeps /healthz', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' })
  })
})

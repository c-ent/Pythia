import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskRequest, AskService } from '../ask/askService.js'
import { testAuth } from './testAuth.js'
import { createMemorySyncStore } from '../sync/memorySyncStore.js'
import { createSyncService } from '../sync/syncService.js'
import type { RepoService } from '../search/repoService.js'
import type { BacklinkService, BacklinksRequest } from '../search/backlinkService.js'
import type { GraphRequest, GraphService, LocalGraphRequest } from '../search/graphService.js'
import type { RelatedRequest, RelatedService } from '../search/relatedService.js'
import type { TopicMapRequest, TopicMapService } from '../search/topicMapService.js'
import {
  AmbiguousDocumentError,
  type DocumentView,
  type ListDocumentsRequest,
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
const { auth, cookie } = await testAuth()
const fetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } })

describe('REST API', () => {
  let server: Server
  let base: string
  const searches: SearchRequest[] = []
  const recents: RecentRequest[] = []
  const fileLists: ListDocumentsRequest[] = []

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
    async listDocuments(request) {
      fileLists.push(request)
      return { documents: [view], total: 1 }
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

  const relatedCalls: RelatedRequest[] = []
  const relatedService: RelatedService = {
    async related(request) {
      relatedCalls.push(request)
      if (request.documentId === 13) throw new Error('relation "secret text" does not exist')
      if (request.documentId === 9) return { documentId: 9, inMap: false, related: [] }
      if (request.documentId !== 7) return null
      return {
        documentId: 7,
        inMap: true,
        related: [
          {
            documentId: 21,
            source: { kind: 'keep', name: 'keep' },
            path: 'Keep/Garden.json',
            title: 'Garden',
            allowLlm: true,
            score: 0.83,
            band: 'strong',
            passage: { chunkId: 5, headingPath: 'Garden', startLine: null, endLine: null, text: 'Tomatoes need sun.', truncated: false },
          },
        ],
      }
    },
  }

  const backlinkCalls: BacklinksRequest[] = []
  const backlinkService: BacklinkService = {
    async backlinks(request) {
      backlinkCalls.push(request)
      if (request.documentId === 13) throw new Error('relation "secret text" does not exist')
      if (request.documentId !== 7) return null
      return {
        documentId: 7,
        supported: true,
        backlinks: [
          {
            id: 22,
            source: { kind: 'obsidian', name: 'vault' },
            sourceLabel: 'Obsidian',
            title: 'Bread log',
            allowLlm: true,
            count: 2,
            display: null,
            heading: null,
            passage: { headingPath: 'Bread log', text: 'See [[Pythia]].' },
          },
        ],
        outgoing: [{ target: 'Ghost', heading: null, display: null, documentId: null }],
      }
    },
  }

  const graphCalls: (LocalGraphRequest | GraphRequest)[] = []
  const topicMapCalls: TopicMapRequest[] = []
  const topicMapService: TopicMapService = {
    async map(request) {
      topicMapCalls.push(request)
      return {
        topic: request.topic,
        branches: [{ label: 'soil · garden', documents: [{ documentId: 7, source: view.source, path: view.path, title: view.title, allowLlm: true }] }],
      }
    },
  }
  const graphService: GraphService = {
    async local(request) {
      graphCalls.push(request)
      if (request.documentId === 13) throw new Error('relation "secret text" does not exist')
      if (request.documentId !== 7) return null
      return {
        documentId: 7,
        inMap: true,
        center: 'doc:7',
        nodes: [
          { id: 'doc:7', type: 'document', label: 'Pythia', documentId: 7, source: { kind: 'obsidian', name: 'vault' }, sourceLabel: 'Obsidian', path: 'Projects/Pythia.md', allowLlm: true, links: 1, depth: 0 },
          { id: 'tag:ai', type: 'tag', label: 'ai', documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 1, depth: 1 },
        ],
        edges: [{ source: 'doc:7', target: 'tag:ai', kind: 'tag', score: null }],
        truncated: false,
      }
    },
    async vault(request) {
      graphCalls.push(request)
      return { nodes: [], edges: [], truncated: false }
    },
  }

  beforeAll(async () => {
    server = createServer(
      createApp({
        search: service,
        ask: askService,
        auth,
        sync,
        repos,
        related: relatedService,
        backlinks: backlinkService,
        graph: graphService,
        topicMap: topicMapService,
      }),
    )
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

  it('builds a topic map from validated input', async () => {
    const res = await post('/api/topic-map', JSON.stringify({ topic: ' gardens ', sources: ['keep'], repo: 'notes' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ topic: 'gardens', branches: [{ label: 'soil · garden' }] })
    expect(topicMapCalls.at(-1)).toEqual({ topic: 'gardens', sources: ['keep'], repo: 'notes' })
  })

  it.each([
    ['empty topic', { topic: '  ' }],
    ['unknown source', { topic: 'x', sources: ['work'] }],
  ])('rejects topic map input with %s', async (_name, body) => {
    const res = await post('/api/topic-map', JSON.stringify(body))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
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

  it('lists related documents with no caching', async () => {
    const res = await fetch(`${base}/api/documents/7/related`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      documentId: 7,
      inMap: true,
      related: [{ documentId: 21, source: { kind: 'keep' }, band: 'strong', passage: { text: 'Tomatoes need sun.' } }],
    })
    expect(relatedCalls.at(-1)).toEqual({ documentId: 7 })
  })

  it('passes related source, repo and limit filters', async () => {
    const res = await fetch(`${base}/api/documents/7/related?sources=keep,%20gdrive&repo=pythia&limit=3`)
    expect(res.status).toBe(200)
    expect(relatedCalls.at(-1)).toEqual({ documentId: 7, sources: ['keep', 'gdrive'], repo: 'pythia', limit: 3 })
  })

  it('answers an empty list for a document outside the map', async () => {
    const res = await fetch(`${base}/api/documents/9/related`)
    expect(await res.json()).toEqual({ documentId: 9, inMap: false, related: [] })
  })

  it.each([
    ['a bad id', '/api/documents/abc/related'],
    ['the work kind', '/api/documents/7/related?sources=work'],
    ['an unknown kind', '/api/documents/7/related?sources=keep,email'],
    ['an empty sources list', '/api/documents/7/related?sources=,'],
    ['a limit above 8', '/api/documents/7/related?limit=9'],
    ['a limit of 0', '/api/documents/7/related?limit=0'],
  ])('returns 400 for related with %s', async (_name, path) => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('returns 404 for related of a missing document and hides internal errors', async () => {
    const missing = await fetch(`${base}/api/documents/8/related`)
    expect(missing.status).toBe(404)
    const broken = await fetch(`${base}/api/documents/13/related`)
    expect(broken.status).toBe(500)
    expect(await broken.text()).not.toContain('secret')
  })

  it('lists backlinks and outgoing links with no caching', async () => {
    const res = await fetch(`${base}/api/documents/7/backlinks`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      documentId: 7,
      supported: true,
      backlinks: [{ id: 22, sourceLabel: 'Obsidian', count: 2, passage: { text: 'See [[Pythia]].' } }],
      outgoing: [{ target: 'Ghost', documentId: null }],
    })
    expect(backlinkCalls.at(-1)).toEqual({ documentId: 7 })
  })

  it('passes the backlinks limit', async () => {
    const res = await fetch(`${base}/api/documents/7/backlinks?limit=5`)
    expect(res.status).toBe(200)
    expect(backlinkCalls.at(-1)).toEqual({ documentId: 7, limit: 5 })
  })

  it.each([
    ['a bad id', '/api/documents/abc/backlinks'],
    ['a limit above 200', '/api/documents/7/backlinks?limit=201'],
    ['a limit of 0', '/api/documents/7/backlinks?limit=0'],
  ])('returns 400 for backlinks with %s', async (_name, path) => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('returns 404 for backlinks of a missing document and hides internal errors', async () => {
    const missing = await fetch(`${base}/api/documents/8/backlinks`)
    expect(missing.status).toBe(404)
    const broken = await fetch(`${base}/api/documents/13/backlinks`)
    expect(broken.status).toBe(500)
    expect(await broken.text()).not.toContain('secret')
  })

  it('returns the local graph of a document with no caching', async () => {
    const res = await fetch(`${base}/api/documents/7/graph`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({
      documentId: 7,
      center: 'doc:7',
      nodes: [{ id: 'doc:7', depth: 0 }, { id: 'tag:ai', type: 'tag' }],
      edges: [{ source: 'doc:7', target: 'tag:ai', kind: 'tag' }],
    })
    expect(graphCalls.at(-1)).toEqual({ documentId: 7 })
  })

  it('passes graph source and repo filters', async () => {
    await fetch(`${base}/api/documents/7/graph?sources=keep,obsidian&repo=pythia`)
    expect(graphCalls.at(-1)).toEqual({ documentId: 7, sources: ['keep', 'obsidian'], repo: 'pythia' })
    const res = await fetch(`${base}/api/graph?sources=keep`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ nodes: [], edges: [], truncated: false })
    expect(graphCalls.at(-1)).toEqual({ sources: ['keep'] })
  })

  it.each([
    ['a bad id', '/api/documents/abc/graph'],
    ['the work kind', '/api/documents/7/graph?sources=work'],
    ['the work kind on the whole-vault graph', '/api/graph?sources=work'],
    ['an unknown kind', '/api/graph?sources=keep,email'],
  ])('returns 400 for graphs with %s', async (_name, path) => {
    const res = await fetch(`${base}${path}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('returns 404 for the graph of a missing document and hides internal errors', async () => {
    const missing = await fetch(`${base}/api/documents/8/graph`)
    expect(missing.status).toBe(404)
    const broken = await fetch(`${base}/api/documents/13/graph`)
    expect(broken.status).toBe(500)
    expect(await broken.text()).not.toContain('secret')
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

  it('lists files for a source and optional repo name with no caching', async () => {
    const res = await fetch(`${base}/api/files?source=repo&name=kitchen-app&limit=50`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ documents: [{ id: 7, path: 'Projects/Pythia.md' }], total: 1 })
    expect(fileLists.at(-1)).toEqual({ source: 'repo', name: 'kitchen-app', limit: 50 })
  })

  it.each(['', 'source=work', 'source=obsidian&limit=0', 'source=obsidian&limit=99999'])(
    'returns 400 for files query %s',
    async (q) => {
      const res = await fetch(`${base}/api/files${q === '' ? '' : `?${q}`}`)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
    },
  )

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

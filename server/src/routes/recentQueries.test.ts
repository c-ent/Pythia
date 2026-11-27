import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskRequest, AskService } from '../ask/askService.js'
import {
  createMemoryRecentQueryStore,
  createRecentQueryService,
  MAX_RECENT_QUERIES,
  MAX_RECENT_QUERY_CHARS,
  normalizeRecentQuery,
  parseRecentQueryFilters,
  type RecentQueryStore,
} from '../recent/recentQueryService.js'
import { testAuth } from './testAuth.js'
import type { SearchRequest, SearchService } from '../search/searchService.js'

const { auth, cookie } = await testAuth()

const search = {
  async search(request: SearchRequest) {
    if (request.query === 'boom') throw new Error('search failed')
    return { results: [], degraded: false }
  },
} as unknown as SearchService
const ask = {
  async ask(request: AskRequest) {
    if (request.question === 'boom') throw new Error('ask failed')
    return { answer: 'Yes.', engine: 'retrieval', citations: [] }
  },
} as unknown as AskService

describe('recent queries', () => {
  let server: Server
  let base: string
  let store: RecentQueryStore

  beforeAll(async () => {
    const recent = createRecentQueryService({
      record: (...args) => store.record(...args),
      list: (...args) => store.list(...args),
      remove: (id) => store.remove(id),
      clear: (kind) => store.clear(kind),
    })
    server = createServer(createApp({ search, ask, auth, recent }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    store = createMemoryRecentQueryStore()
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const headers = { 'content-type': 'application/json', cookie }
  const runSearch = (body: unknown) => fetch(`${base}/api/search`, { method: 'POST', headers, body: JSON.stringify(body) })
  const runAsk = (body: unknown) => fetch(`${base}/api/ask`, { method: 'POST', headers, body: JSON.stringify(body) })
  const list = async (kind: string) => {
    const res = await fetch(`${base}/api/recent-queries?kind=${kind}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    return ((await res.json()) as { queries: { id: number; query: string; filters: unknown; at: string }[] }).queries
  }

  it('needs a session', async () => {
    const res = await fetch(`${base}/api/recent-queries?kind=search`)
    expect(res.status).toBe(401)
  })

  it('records a search that ran, with its filters, and never caches the list', async () => {
    await runSearch({ query: ' goals ', sources: ['obsidian'], repo: 'pythia' })
    const res = await fetch(`${base}/api/recent-queries?kind=search`, { headers: { cookie } })
    expect(res.headers.get('cache-control')).toBe('no-store')
    const [entry, ...rest] = ((await res.json()) as { queries: Record<string, unknown>[] }).queries
    expect(rest).toEqual([])
    expect(entry).toMatchObject({ kind: 'search', query: 'goals', filters: { sources: ['obsidian'], repo: 'pythia' } })
    expect(Number.isNaN(Date.parse(String(entry?.at)))).toBe(false)
    expect(await list('ask')).toEqual([])
  })

  it('records Ask questions in their own list', async () => {
    await runAsk({ question: 'what are my goals?' })
    expect((await list('ask')).map((entry) => entry.query)).toEqual(['what are my goals?'])
    expect(await list('search')).toEqual([])
  })

  it('does not record a query that failed or was refused', async () => {
    expect((await runSearch({ query: 'boom' })).status).toBe(500)
    expect((await runSearch({ query: '   ' })).status).toBe(400)
    expect((await runAsk({ question: 'boom' })).status).toBe(500)
    expect(await list('search')).toEqual([])
    expect(await list('ask')).toEqual([])
  })

  it('moves a repeated query to the top instead of adding a copy', async () => {
    await runSearch({ query: 'one' })
    await runSearch({ query: 'two' })
    await runSearch({ query: 'one', sources: ['keep'] })
    const entries = await list('search')
    expect(entries.map((entry) => entry.query)).toEqual(['one', 'two'])
    expect(entries[0]?.filters).toEqual({ sources: ['keep'] })
  })

  it('keeps the newest 20 of each kind', async () => {
    for (let i = 1; i <= MAX_RECENT_QUERIES + 1; i += 1) await runSearch({ query: `q${i}` })
    const entries = await list('search')
    expect(entries).toHaveLength(MAX_RECENT_QUERIES)
    expect(entries[0]?.query).toBe('q21')
    expect(entries.map((entry) => entry.query)).not.toContain('q1')
  })

  it('removes one entry and answers 404 for one that is gone', async () => {
    await runSearch({ query: 'one' })
    await runSearch({ query: 'two' })
    const [first] = await list('search')
    const del = () => fetch(`${base}/api/recent-queries/${first?.id}`, { method: 'DELETE', headers: { cookie } })
    expect((await del()).status).toBe(204)
    expect((await list('search')).map((entry) => entry.query)).toEqual(['one'])
    expect((await del()).status).toBe(404)
    const bad = await fetch(`${base}/api/recent-queries/abc`, { method: 'DELETE', headers: { cookie } })
    expect(bad.status).toBe(400)
  })

  it('clears one kind and leaves the other', async () => {
    await runSearch({ query: 'one' })
    await runAsk({ question: 'why?' })
    const res = await fetch(`${base}/api/recent-queries?kind=search`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(204)
    expect(await list('search')).toEqual([])
    expect(await list('ask')).toHaveLength(1)
  })

  it.each([
    ['no kind', '/api/recent-queries'],
    ['an unknown kind', '/api/recent-queries?kind=chat'],
    ['a limit above 20', '/api/recent-queries?kind=search&limit=21'],
  ])('answers 400 for %s', async (_name, path) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
  })

  it('still answers the search when recording fails', async () => {
    store = { ...createMemoryRecentQueryStore(), record: async () => Promise.reject(new Error('db down')) }
    const errors: unknown[] = []
    const recent = createRecentQueryService(store, { onError: (error) => errors.push(error) })
    await recent.record('search', 'goals')
    expect(errors).toHaveLength(1)
    const res = await runSearch({ query: 'goals' })
    expect(res.status).toBe(200)
  })
})

describe('normalizeRecentQuery', () => {
  it('trims, refuses empty text and cuts long text to 500 characters', () => {
    expect(normalizeRecentQuery('  goals  ')).toBe('goals')
    expect(normalizeRecentQuery(' \n\t ')).toBeNull()
    expect(normalizeRecentQuery('x'.repeat(MAX_RECENT_QUERY_CHARS + 50))).toHaveLength(MAX_RECENT_QUERY_CHARS)
    const emoji = normalizeRecentQuery('😀'.repeat(MAX_RECENT_QUERY_CHARS + 1)) ?? ''
    expect(Array.from(emoji)).toHaveLength(MAX_RECENT_QUERY_CHARS)
    expect(emoji.endsWith('😀')).toBe(true)
  })
})

describe('parseRecentQueryFilters', () => {
  it('keeps known sources and a repo name, and drops anything else', () => {
    expect(parseRecentQueryFilters({ sources: ['obsidian', 'work', 3], repo: 'pythia', extra: true })).toEqual({
      sources: ['obsidian'],
      repo: 'pythia',
    })
    expect(parseRecentQueryFilters({ sources: [], repo: '' })).toEqual({})
    expect(parseRecentQueryFilters(null)).toEqual({})
    expect(parseRecentQueryFilters('x')).toEqual({})
  })
})

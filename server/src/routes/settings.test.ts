import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import {
  buildExclusionCatalog,
  createMemoryLlmExclusionStore,
  type LlmExclusionCatalog,
  type LlmExclusionStore,
} from '../ingest/llmExclusions.js'
import { testAuth } from './testAuth.js'
import type { SearchService } from '../search/searchService.js'
import { createSettingsService, MAX_LLM_EXCLUSIONS } from '../settings/settingsService.js'

const { auth, cookie } = await testAuth()

const search = {} as SearchService
const ask = {} as AskService

describe('settings routes: Gemini exclusion list', () => {
  let server: Server
  let base: string
  let store: LlmExclusionStore
  let catalog: LlmExclusionCatalog
  let refreshes = 0

  beforeAll(async () => {
    const app = createApp({
      search,
      ask,
      auth,
      settings: createSettingsService({
        exclusions: {
          list: () => store.list(),
          replace: (list) => store.replace(list),
          countDocuments: (list) => store.countDocuments(list),
        },
        catalog: async () => catalog,
        refreshAllowLlm: async () => {
          refreshes++
        },
      }),
    })
    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  beforeEach(() => {
    store = createMemoryLlmExclusionStore()
    catalog = buildExclusionCatalog({ obsidianDocs: [], drivePaths: [], keepDocuments: 0 })
    refreshes = 0
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const get = (withCookie = true) =>
    fetch(`${base}/api/settings/llm-exclusions`, { headers: withCookie ? { cookie } : {} })
  const getCatalog = (withCookie = true) =>
    fetch(`${base}/api/settings/llm-exclusions/catalog`, { headers: withCookie ? { cookie } : {} })
  const put = (body: unknown, withCookie = true) =>
    fetch(`${base}/api/settings/llm-exclusions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  /** Rules as the API returns them; the memory store holds no documents, so every count is 0. */
  const counted = (list: { kind: string; path: string }[]) => list.map((rule) => ({ ...rule, documents: 0 }))

  it('starts empty', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ exclusions: [] })
  })

  it('saves a folder and a single note, normalized, deduplicated and sorted', async () => {
    const res = await put({
      exclusions: [
        { kind: 'note', path: 'Journal\\2026\\today.md' },
        { kind: 'folder', path: '/Private/' },
        { kind: 'folder', path: 'private' },
        { kind: 'folder', path: './Work/Secret' },
      ],
    })
    expect(res.status).toBe(200)
    const saved = {
      exclusions: counted([
        { kind: 'folder', path: 'Private' },
        { kind: 'folder', path: 'Work/Secret' },
        { kind: 'note', path: 'Journal/2026/today.md' },
      ]),
    }
    expect(await res.json()).toEqual(saved)
    expect(await (await get()).json()).toEqual(saved)
    expect(refreshes).toBe(1)
  })

  it('saves tag, repo and Keep rules, normalized, and returns their document counts', async () => {
    store = createMemoryLlmExclusionStore([], (rule) => (rule.kind === 'keep' ? 7 : rule.kind === 'tag' ? 3 : 0))
    const res = await put({
      exclusions: [
        { kind: 'keep' },
        { kind: 'repo', path: ' pythia ' },
        { kind: 'tag', path: '#Private/' },
        { kind: 'tag', path: 'private' },
        { kind: 'keep', path: 'anything' },
      ],
    })
    expect(res.status).toBe(200)
    const saved = {
      exclusions: [
        { kind: 'tag', path: 'private', documents: 3 },
        { kind: 'repo', path: 'pythia', documents: 0 },
        { kind: 'keep', path: 'keep', documents: 7 },
      ],
    }
    expect(await res.json()).toEqual(saved)
    expect(await (await get()).json()).toEqual(saved)
  })

  it('saves Drive rules for the whole Drive and for a folder, normalized, with counts', async () => {
    store = createMemoryLlmExclusionStore([], (rule) => (rule.kind !== 'gdrive' ? 0 : rule.path === '/' ? 9 : 4))
    const res = await put({
      exclusions: [
        { kind: 'gdrive', path: '/Clients/Acme/' },
        { kind: 'gdrive' },
        { kind: 'gdrive', path: ' / ' },
        { kind: 'gdrive', path: 'clients/acme' },
      ],
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      exclusions: [
        { kind: 'gdrive', path: '/', documents: 9 },
        { kind: 'gdrive', path: 'Clients/Acme', documents: 4 },
      ],
    })
  })

  it.each([['../etc'], ['a//b'], ['Work/../Home']])('rejects the Drive folder %s', async (path) => {
    const res = await put({ exclusions: [{ kind: 'gdrive', path }] })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/exclusions\.0\.path/)
  })

  it('removes entries by saving the shorter list', async () => {
    await put({ exclusions: [{ kind: 'folder', path: 'Private' }, { kind: 'note', path: 'a.md' }] })
    await put({ exclusions: [{ kind: 'note', path: 'a.md' }] })
    expect(await (await get()).json()).toEqual({ exclusions: counted([{ kind: 'note', path: 'a.md' }]) })
    await put({ exclusions: [] })
    expect(await (await get()).json()).toEqual({ exclusions: [] })
    expect(refreshes).toBe(3)
  })

  it.each([
    [{ exclusions: [{ kind: 'folder', path: '../outside' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'folder', path: '   ' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'note', path: 'Notes/plan' }] }, /\.md/],
    [{ exclusions: [{ kind: 'secret', path: 'x' }] }, /exclusions\.0\.kind/],
    [{ exclusions: [{ kind: 'tag', path: '#' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'repo', path: '../pythia' }] }, /exclusions\.0\.path/],
    [{ exclusions: [{ kind: 'folder', path: 'a\u0000b' }] }, /control characters/],
    [{ exclusions: 'Private' }, /exclusions/],
    [{}, /exclusions/],
  ])('rejects invalid input %# with 400 and keeps the stored list', async (body, message) => {
    await put({ exclusions: [{ kind: 'folder', path: 'Keep' }] })
    const res = await put(body)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('invalid_input')
    expect(json.error.message).toMatch(message)
    expect(await (await get()).json()).toEqual({ exclusions: counted([{ kind: 'folder', path: 'Keep' }]) })
  })

  it('rejects a list longer than the limit', async () => {
    const exclusions = Array.from({ length: MAX_LLM_EXCLUSIONS + 1 }, (_, i) => ({ kind: 'folder', path: `f${i}` }))
    expect((await put({ exclusions })).status).toBe(400)
  })

  it('needs a session for reading and saving', async () => {
    expect((await get(false)).status).toBe(401)
    expect((await getCatalog(false)).status).toBe(401)
    expect((await put({ exclusions: [] }, false)).status).toBe(401)
    expect(await store.list()).toEqual([])
  })

  it('returns the browseable exclusion catalog', async () => {
    catalog = buildExclusionCatalog({
      obsidianDocs: [
        { path: 'Work/Clients/Acme.md', tags: ['#Private/Health', 'client'] },
        { path: 'Work/Notes.md', tags: ['private'] },
        { path: 'Home.md', tags: [] },
      ],
      drivePaths: ['Finance/2026/Budget.xlsx', 'Finance/Summary.docx', 'Readme.pdf'],
      keepDocuments: 14,
    })
    const res = await getCatalog()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      obsidian: {
        folders: [
          { path: 'Work', documents: 2 },
          { path: 'Work/Clients', documents: 1 },
        ],
        notes: ['Home.md', 'Work/Clients/Acme.md', 'Work/Notes.md'],
        tags: [
          { tag: 'client', documents: 1 },
          { tag: 'private', documents: 2 },
          { tag: 'private/health', documents: 1 },
        ],
      },
      gdrive: {
        totalDocuments: 3,
        folders: [
          { path: 'Finance', documents: 2 },
          { path: 'Finance/2026', documents: 1 },
        ],
        files: ['Finance/2026/Budget.xlsx', 'Finance/Summary.docx', 'Readme.pdf'],
      },
      keep: { documents: 14 },
    })
  })
})

describe('settings routes without a settings service', () => {
  it('answers 404', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const res = await fetch(`${base}/api/settings/llm-exclusions`, { headers: { cookie } })
      expect(res.status).toBe(404)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

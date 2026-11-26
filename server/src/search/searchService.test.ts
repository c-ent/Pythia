import { describe, expect, it } from 'vitest'
import {
  HEADLINE_START as S,
  HEADLINE_STOP as E,
  type ChunkHit,
  type HybridSearchParams,
  type SearchStore,
  type StoredDocument,
} from '../db/searchStore.js'
import { EMBED_DIMENSIONS, OllamaError, type Embedder } from '../embed/ollama.js'
import { capText, createSearchService, parseHeadline, SearchInputError, AmbiguousDocumentError } from './searchService.js'

const hit = (over: Partial<ChunkHit> = {}): ChunkHit => ({
  chunkId: 1,
  documentId: 10,
  sourceKind: 'obsidian',
  sourceName: 'vault',
  path: 'a.md',
  title: 'a',
  headingPath: 'a > Goals',
  startLine: 1,
  endLine: 3,
  allowLlm: true,
  score: 0.03,
  ftsRank: 1,
  vectorRank: 2,
  headline: `the ${S}goal${E} here`,
  ...over,
})

const doc = (over: Partial<StoredDocument> = {}): StoredDocument => ({
  id: 10,
  sourceKind: 'obsidian',
  sourceName: 'vault',
  path: 'a.md',
  title: 'a',
  language: null,
  allowLlm: true,
  mtime: null,
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  chunks: ['# Goals\n\nOne.', '## Risks\n\nTwo.'],
  ...over,
})

function fakeStore(over: Partial<SearchStore> = {}) {
  const calls: HybridSearchParams[] = []
  const store: SearchStore = {
    async hybridSearch(params) {
      calls.push(params)
      return [hit()]
    },
    async getDocument(id) {
      return id === 10 ? doc() : null
    },
    async findDocumentIds() {
      return [10]
    },
    async recentDocuments() {
      return [doc()]
    },
    ...over,
  }
  return { store, calls }
}

const embedder = (fail = false): Embedder => ({
  model: 'nomic-embed-text',
  dimensions: EMBED_DIMENSIONS,
  async embedDocuments() {
    throw new Error('not used')
  },
  async embedQuery() {
    if (fail) throw new OllamaError('Ollama request failed', { status: 503, retryable: true })
    return Array.from({ length: EMBED_DIMENSIONS }, () => 0.1)
  },
})

describe('parseHeadline', () => {
  it('returns plain text and match offsets', () => {
    expect(parseHeadline(`a ${S}bb${E} c ${S}d${E}`)).toEqual({ text: 'a bb c d', highlights: [[2, 4], [7, 8]] })
  })

  it('drops empty and unclosed markers safely', () => {
    expect(parseHeadline(`${S}${E}x ${S}yz`)).toEqual({ text: 'x yz', highlights: [[2, 4]] })
  })

  it('counts offsets in UTF-16 units', () => {
    const { text, highlights } = parseHeadline(`😀 ${S}ok${E}`)
    expect(text.slice(highlights[0][0], highlights[0][1])).toBe('ok')
  })
})

describe('capText', () => {
  it('leaves short text alone', () => {
    expect(capText('abc', 10)).toEqual({ text: 'abc', truncated: false })
  })

  it('cuts at a line break near the cap', () => {
    expect(capText('line one\nline two', 12)).toEqual({ text: 'line one', truncated: true })
  })

  it('cuts hard when no line break is near and never splits a surrogate pair', () => {
    const result = capText('aaaa😀bbbb', 5)
    expect(result).toEqual({ text: 'aaaa', truncated: true })
  })
})

describe('search service', () => {
  it('rejects an empty query', async () => {
    const service = createSearchService({ store: fakeStore().store, embedder: embedder() })
    await expect(service.search({ query: '   ' })).rejects.toBeInstanceOf(SearchInputError)
  })

  it('passes the query vector, filters, 50 candidates and a clamped limit to the store', async () => {
    const { store, calls } = fakeStore()
    const service = createSearchService({ store, embedder: embedder() })
    const response = await service.search({ query: ' goals ', sources: ['repo'], repo: 'pythia', limit: 500 })
    expect(calls[0]).toMatchObject({
      query: 'goals',
      embedModel: 'nomic-embed-text',
      filters: { sources: ['repo'], repo: 'pythia' },
      candidates: 50,
      limit: 50,
    })
    expect(calls[0]?.embedding).toHaveLength(EMBED_DIMENSIONS)
    expect(response.degraded).toBe(false)
    expect(response.results[0]).toMatchObject({
      source: { kind: 'obsidian', name: 'vault' },
      headingPath: 'a > Goals',
      snippet: { text: 'the goal here', highlights: [[4, 8]] },
    })
  })

  it('falls back to full text only when the embedder fails, logging no query text', async () => {
    const { store, calls } = fakeStore()
    const logs: string[] = []
    const service = createSearchService({ store, embedder: embedder(true), log: (m) => logs.push(m) })
    const response = await service.search({ query: 'my secret plans' })
    expect(response.degraded).toBe(true)
    expect(calls[0]?.embedding).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('OllamaError 503')
    expect(logs[0]).not.toContain('secret')
  })

  it('joins chunks into the document and caps it', async () => {
    const service = createSearchService({ store: fakeStore().store, embedder: embedder(), maxDocumentChars: 15 })
    const view = await service.getDocument(10)
    expect(view).toMatchObject({ content: '# Goals\n\nOne.', truncated: true, totalChars: 29 })
    expect(await service.getDocument(99)).toBeNull()
  })

  it('refuses a path held by several sources of the kind', async () => {
    const { store } = fakeStore({ findDocumentIds: async () => [1, 2] })
    const service = createSearchService({ store, embedder: embedder() })
    await expect(service.findDocument('repo', null, 'README.md')).rejects.toBeInstanceOf(AmbiguousDocumentError)
  })

  it('returns null for a path no source has', async () => {
    const { store } = fakeStore({ findDocumentIds: async () => [] })
    const service = createSearchService({ store, embedder: embedder() })
    expect(await service.findDocument('obsidian', null, 'nope.md')).toBeNull()
  })

  it('asks for documents changed since now minus days', async () => {
    let since: Date | undefined
    let sources: readonly string[] | undefined
    const { store } = fakeStore({
      recentDocuments: async (params) => {
        since = params.since
        sources = params.sources
        return []
      },
    })
    const now = () => new Date('2026-11-25T12:00:00Z')
    const service = createSearchService({ store, embedder: embedder(), now })
    await service.recent({ days: 3, source: 'keep', limit: 5 })
    expect(since?.toISOString()).toBe('2026-11-22T12:00:00.000Z')
    expect(sources).toEqual(['keep'])
  })
})

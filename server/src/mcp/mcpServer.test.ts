import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import type { AuthDeps } from '../routes/auth.js'
import { createMcpTokenService, createMemoryMcpTokenStore } from './mcpToken.js'
import {
  AmbiguousDocumentError,
  type DocumentInfo,
  type DocumentView,
  type RecentRequest,
  type SearchRequest,
  type SearchResult,
  type SearchService,
} from '../search/searchService.js'
import { WITHHELD_TEXT } from './mcpServer.js'
import type { RepoInfo, RepoService } from '../search/repoService.js'
import type { BacklinkService } from '../search/backlinkService.js'
import type { RelatedService } from '../search/relatedService.js'
import type { TopicMapService } from '../search/topicMapService.js'

const mcpToken = 'test-mcp-token-' + 'x'.repeat(24)
const SECRET_TEXT = 'private rent amount 1234'

function hit(over: Partial<SearchResult>): SearchResult {
  return {
    chunkId: 1,
    documentId: 1,
    source: { kind: 'obsidian', name: 'vault' },
    path: 'Notes/Open.md',
    title: 'Open',
    headingPath: 'Open > Intro',
    startLine: 1,
    endLine: 4,
    allowLlm: true,
    score: 0.0327868852,
    ftsRank: 1,
    vectorRank: 1,
    snippet: { text: 'open snippet about pgvector', highlights: [[19, 27]] },
    ...over,
  }
}

const info = (over: Partial<DocumentInfo>): DocumentInfo => ({
  id: 1,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Notes/Open.md',
  title: 'Open',
  language: null,
  allowLlm: true,
  mtime: new Date('2026-11-20T10:00:00Z'),
  updatedAt: new Date('2026-11-20T10:00:05Z'),
  ...over,
})

const docs: Record<string, DocumentView> = {
  'Notes/Open.md': { ...info({}), content: '# Open\nopen body', truncated: false, totalChars: 16 },
  'Private/Money.md': {
    ...info({ id: 2, path: 'Private/Money.md', title: 'Money', allowLlm: false }),
    content: SECRET_TEXT,
    truncated: false,
    totalChars: SECRET_TEXT.length,
  },
}

const calls: { search: SearchRequest[]; recent: RecentRequest[] } = { search: [], recent: [] }
let failNext: Error | null = null

const search: SearchService = {
  async search(request) {
    calls.search.push(request)
    if (failNext !== null) {
      const error = failNext
      failNext = null
      throw error
    }
    return {
      degraded: false,
      results: [
        hit({}),
        hit({
          chunkId: 2,
          documentId: 2,
          path: 'Private/Money.md',
          title: 'Money',
          allowLlm: false,
          snippet: { text: SECRET_TEXT, highlights: [] },
        }),
      ],
    }
  },
  async getDocument() {
    return null
  },
  async findDocument(_kind, name, path) {
    if (path === 'README.md' && name === null) throw new AmbiguousDocumentError('Several repo sources hold README.md; pass name')
    return docs[path] ?? null
  },
  async recent(request) {
    calls.recent.push(request)
    return [info({}), info({ id: 2, path: 'Private/Money.md', title: 'Money', allowLlm: false })]
  },
}

const ask: AskService = {
  async ask() {
    return { answer: null, engine: 'retrieval', model: null, fallbacks: ['no_results'], citations: [], withheld: 0, degraded: false }
  },
}

const auth: AuthDeps = { login: null, mcp: createMcpTokenService({ envToken: mcpToken, store: createMemoryMcpTokenStore() }) }

const repoInfo: RepoInfo = { name: 'kitchen-app', files: 12, chunks: 40, updatedAt: new Date('2026-11-21T08:00:00Z') }
const repos: RepoService = {
  async listRepos() {
    return [repoInfo]
  },
  async getOverview(name) {
    if (name !== 'kitchen-app') return null
    return { ...repoInfo, summary: { documentId: 30, allowLlm: true, text: 'Repository: kitchen-app\n\nLanguages: typescript (12)' } }
  },
}

const related: RelatedService = {
  async related({ documentId }) {
    if (documentId === 404) return null
    return {
      documentId,
      inMap: true,
      related: [
        { documentId: 3, source: { kind: 'obsidian', name: 'vault' }, path: 'Public.md', title: 'Public', allowLlm: true, score: 0.9, band: 'strong', passage: { chunkId: 1, headingPath: 'Public', startLine: 1, endLine: 1, text: 'Public passage', truncated: false } },
        { documentId: 4, source: { kind: 'obsidian', name: 'vault' }, path: 'Private.md', title: 'Private', allowLlm: false, score: 0.8, band: 'strong', passage: { chunkId: 2, headingPath: 'Private', startLine: 1, endLine: 1, text: SECRET_TEXT, truncated: false } },
      ],
    }
  },
}

const backlinks: BacklinkService = {
  async backlinks({ documentId }) {
    if (documentId === 404) return null
    return {
      documentId,
      supported: true,
      backlinks: [{ id: 5, source: { kind: 'obsidian', name: 'vault' }, sourceLabel: 'Obsidian', title: 'Private backlink', allowLlm: false, count: 1, display: null, heading: null, passage: { headingPath: 'Private', text: SECRET_TEXT } }],
      outgoing: [],
    }
  },
}

const topicMap: TopicMapService = {
  async map({ topic }) {
    return {
      topic,
      branches: [
        {
          label: SECRET_TEXT,
          documents: [
            { documentId: 3, source: { kind: 'obsidian', name: 'vault' }, path: 'Public.md', title: 'Public', allowLlm: true },
            { documentId: 4, source: { kind: 'obsidian', name: 'vault' }, path: 'Private.md', title: 'Private', allowLlm: false },
          ],
        },
      ],
    }
  },
}

let base = ''
let close: () => Promise<void> = async () => {}
const clients: Client[] = []

beforeAll(async () => {
  const server = createServer(createApp({ search, ask, auth, repos, related, backlinks, topicMap }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  calls.search.length = 0
  calls.recent.length = 0
})

afterAll(async () => {
  await close()
})

async function connect(token = mcpToken): Promise<Client> {
  const client = new Client({ name: 'pythia-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  clients.push(client)
  return client
}

function body(result: unknown): unknown {
  const content = (result as CallToolResult).content[0]
  if (content?.type !== 'text') throw new Error('expected text content')
  return JSON.parse(content.text)
}

function errorText(result: unknown): string {
  const r = result as CallToolResult
  expect(r.isError).toBe(true)
  const content = r.content[0]
  return content?.type === 'text' ? content.text : ''
}

describe('MCP server at /mcp', () => {
  it('refuses a Funnel request with a valid token before any tool runs (R7)', async () => {
    const client = new Client({ name: 'pythia-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${mcpToken}`, 'tailscale-funnel-request': '?1', 'x-forwarded-for': '203.0.113.9' },
      },
    })
    await expect(client.connect(transport)).rejects.toThrow(/403|tailnet/i)
    await client.close()

    // A raw tool call gets the same 403 and never reaches the search service.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mcpToken}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'rent' } } }),
    })
    expect(res.status).toBe(403)
    expect(calls.search).toEqual([])
  })

  it('serves tools to a tailnet request', async () => {
    const client = new Client({ name: 'pythia-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}`, 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' } },
    })
    await client.connect(transport)
    clients.push(client)
    const result = await client.callTool({ name: 'search', arguments: { query: 'pgvector' } })
    expect((result as CallToolResult).isError).toBeFalsy()
    expect(calls.search).toHaveLength(1)
  })

  it('lists the read-only tools with input schemas', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'backlinks',
      'get_document',
      'get_repo_overview',
      'list_repos',
      'recent_changes',
      'related_documents',
      'search',
      'topic_map',
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.inputSchema.type).toBe('object')
    }
    const searchTool = tools.find((t) => t.name === 'search')
    expect(searchTool?.inputSchema.required).toEqual(['query'])
  })

  it('hides optional tools when their services are not wired', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const client = new Client({ name: 'pythia-test', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
    })
    try {
      await client.connect(transport)
      const { tools } = await client.listTools()
      expect(tools.map((tool) => tool.name)).not.toContain('related_documents')
      expect(tools.map((tool) => tool.name)).not.toContain('backlinks')
      expect(tools.map((tool) => tool.name)).not.toContain('topic_map')
      for (const name of ['related_documents', 'backlinks', 'topic_map']) {
        const result = await client.callTool({ name, arguments: { documentId: 7, topic: 'garden' } })
        expect((result as CallToolResult).isError).toBe(true)
        expect(errorText(result)).toMatch(/not found/)
      }
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('returns related documents with filters and withholds private passages', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'related_documents', arguments: { documentId: 7, sources: ['keep'], repo: 'notes', limit: 3 } })
    const out = body(result) as { related: Array<{ allowLlm: boolean; passage: { text: string } }> }
    expect((result as CallToolResult).isError).toBeFalsy()
    expect(out.related[0]?.passage.text).toBe('Public passage')
    expect(out.related[1]?.passage.text).toBe(WITHHELD_TEXT)
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT)

    const invalid = await client.callTool({ name: 'related_documents', arguments: { documentId: 7, limit: 9 } })
    expect(errorText(invalid)).toMatch(/limit/)
  })

  it('returns backlinks and withholds private passages', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'backlinks', arguments: { documentId: 7, limit: 5 } })
    expect((body(result) as { backlinks: Array<{ passage: { text: string } }> }).backlinks[0]?.passage.text).toBe(WITHHELD_TEXT)
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT)
    expect(errorText(await client.callTool({ name: 'backlinks', arguments: { documentId: 0 } }))).toMatch(/documentId/)
  })

  it('replaces topic-map labels for groups containing locked documents', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'topic_map', arguments: { topic: ' garden ' } })
    expect(body(result)).toEqual({ topic: 'garden', branches: [{ label: 'Topic 1', documents: [
      { documentId: 3, source: { kind: 'obsidian', name: 'vault' }, path: 'Public.md', title: 'Public', allowLlm: true },
      { documentId: 4, source: { kind: 'obsidian', name: 'vault' }, path: 'Private.md', title: 'Private', allowLlm: false },
    ] }] })
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT)
    expect(errorText(await client.callTool({ name: 'topic_map', arguments: { topic: ' ' } }))).toMatch(/topic/)
  })

  it('rejects related tool calls for missing documents', async () => {
    const client = await connect()
    expect(errorText(await client.callTool({ name: 'related_documents', arguments: { documentId: 404 } }))).toMatch(/No visible document/)
    expect(errorText(await client.callTool({ name: 'backlinks', arguments: { documentId: 404 } }))).toMatch(/No visible document/)
  })

  it('search returns results and withholds allow_llm = false snippets', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'search', arguments: { query: '  pgvector ', sources: ['obsidian'], limit: 5 } })
    expect((result as CallToolResult).isError).toBeFalsy()
    const out = body(result) as { degraded: boolean; results: Array<{ path: string; snippet: string; allowLlm: boolean }> }
    expect(out.degraded).toBe(false)
    expect(out.results.map((r) => r.path)).toEqual(['Notes/Open.md', 'Private/Money.md'])
    expect(out.results[0]?.snippet).toBe('open snippet about pgvector')
    expect(out.results[1]).toMatchObject({ allowLlm: false, snippet: WITHHELD_TEXT })
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT)
    // The shared schema trims the query before the service sees it.
    expect(calls.search).toEqual([{ query: 'pgvector', sources: ['obsidian'], limit: 5 }])
  })

  it('rejects invalid tool input before the service runs', async () => {
    const client = await connect()
    const empty = await client.callTool({ name: 'search', arguments: { query: '   ' } })
    expect(errorText(empty)).toMatch(/query/)
    const badSource = await client.callTool({ name: 'search', arguments: { query: 'x', sources: ['email'] } })
    expect((badSource as CallToolResult).isError).toBe(true)
    const tooMany = await client.callTool({ name: 'search', arguments: { query: 'x', limit: 1000 } })
    expect((tooMany as CallToolResult).isError).toBe(true)
    expect(calls.search).toEqual([])
  })

  it('get_document returns the text, withholds private text and reports unknown paths cleanly', async () => {
    const client = await connect()
    const open = body(await client.callTool({ name: 'get_document', arguments: { source: 'obsidian', path: 'Notes/Open.md' } }))
    expect(open).toMatchObject({ path: 'Notes/Open.md', content: '# Open\nopen body', truncated: false, allowLlm: true })

    const priv = await client.callTool({ name: 'get_document', arguments: { source: 'obsidian', path: 'Private/Money.md' } })
    expect(body(priv)).toMatchObject({ path: 'Private/Money.md', allowLlm: false, content: WITHHELD_TEXT })
    expect(JSON.stringify(priv)).not.toContain(SECRET_TEXT)

    const missing = await client.callTool({ name: 'get_document', arguments: { source: 'obsidian', path: 'Nope.md' } })
    expect(errorText(missing)).toBe('No obsidian document at Nope.md')

    const ambiguous = await client.callTool({ name: 'get_document', arguments: { source: 'repo', path: 'README.md' } })
    expect(errorText(ambiguous)).toMatch(/pass name/)
  })

  it('recent_changes applies the defaults and returns ISO dates', async () => {
    const client = await connect()
    const out = body(await client.callTool({ name: 'recent_changes', arguments: {} })) as {
      documents: Array<{ path: string; mtime: string }>
    }
    expect(out.documents.map((d) => d.path)).toEqual(['Notes/Open.md', 'Private/Money.md'])
    expect(out.documents[0]?.mtime).toBe('2026-11-20T10:00:00.000Z')
    expect(calls.recent).toEqual([{ days: 7, limit: 50 }])
  })

  it('list_repos returns names and counts', async () => {
    const client = await connect()
    const out = body(await client.callTool({ name: 'list_repos', arguments: {} }))
    expect(out).toEqual({
      repos: [{ name: 'kitchen-app', files: 12, chunks: 40, updatedAt: '2026-11-21T08:00:00.000Z' }],
    })
  })

  it('get_repo_overview returns the SUMMARY text and reports unknown repos cleanly', async () => {
    const client = await connect()
    const out = body(await client.callTool({ name: 'get_repo_overview', arguments: { name: ' kitchen-app ' } }))
    expect(out).toMatchObject({ name: 'kitchen-app', files: 12, overview: 'Repository: kitchen-app\n\nLanguages: typescript (12)' })

    const missing = await client.callTool({ name: 'get_repo_overview', arguments: { name: 'nope' } })
    expect(errorText(missing)).toMatch(/No indexed repo named nope/)
    const empty = await client.callTool({ name: 'get_repo_overview', arguments: { name: '  ' } })
    expect((empty as CallToolResult).isError).toBe(true)
  })

  it('hides internal error details', async () => {
    const client = await connect()
    failNext = new Error(`connection refused near ${SECRET_TEXT}`)
    const result = await client.callTool({ name: 'search', arguments: { query: 'x' } })
    expect(errorText(result)).toBe('Internal server error')
    expect(JSON.stringify(result)).not.toContain(SECRET_TEXT)
  })

  it('refuses a client with the wrong token', async () => {
    await expect(connect(mcpToken + 'x')).rejects.toThrow()
  })

  it('answers 405 to GET and DELETE because it is stateless', async () => {
    const headers = { authorization: `Bearer ${mcpToken}` }
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })
})

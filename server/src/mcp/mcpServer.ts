import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import express, { type Router } from 'express'
import type { RepoInfo, RepoService } from '../search/repoService.js'
import { documentLookupSchema, recentInputSchema, repoOverviewSchema, searchInputSchema } from '../search/schemas.js'
import {
  AmbiguousDocumentError,
  SearchInputError,
  type DocumentInfo,
  type SearchResult,
  type SearchService,
} from '../search/searchService.js'

// MCP server (R7): the same search and repo services as the REST routes,
// exposed as tools over Streamable HTTP.

export const MCP_SERVER_NAME = 'pythia'
export const MCP_SERVER_VERSION = '0.1.0'

/**
 * Text of `allow_llm = false` documents (`llm: false` notes, notes and
 * folders on the Settings exclusion list) never goes to a model. An MCP client hands every tool
 * result to its LLM, so these results carry metadata only.
 */
export const WITHHELD_TEXT = '[withheld: this document is marked allow_llm = false]'

const text = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const toolError = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
})

const infoView = (doc: DocumentInfo) => ({
  id: doc.id,
  source: doc.source,
  path: doc.path,
  title: doc.title,
  language: doc.language,
  allowLlm: doc.allowLlm,
  mtime: doc.mtime?.toISOString() ?? null,
  updatedAt: doc.updatedAt.toISOString(),
})

const resultView = (hit: SearchResult) => ({
  documentId: hit.documentId,
  source: hit.source,
  path: hit.path,
  title: hit.title,
  headingPath: hit.headingPath,
  lines: hit.startLine === null ? null : [hit.startLine, hit.endLine],
  score: Number(hit.score.toFixed(5)),
  allowLlm: hit.allowLlm,
  snippet: hit.allowLlm ? hit.snippet.text : WITHHELD_TEXT,
})

/** Runs a tool body; known input errors become MCP tool errors, anything else a generic one. */
async function guard(run: () => Promise<CallToolResult>, log: (line: string) => void): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof SearchInputError || error instanceof AmbiguousDocumentError) return toolError(error.message)
    // Name only: messages can quote note text or query values.
    log(`mcp tool failed: ${error instanceof Error ? error.name : 'unknown'}`)
    return toolError('Internal server error')
  }
}

const repoInfoView = (repo: RepoInfo) => ({
  name: repo.name,
  files: repo.files,
  chunks: repo.chunks,
  updatedAt: repo.updatedAt?.toISOString() ?? null,
})

/** One MCP server with Pythia's tools. Stateless: a new one serves each request. */
export function buildMcpServer(
  search: SearchService,
  log: (line: string) => void = console.error,
  repos?: RepoService,
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION })
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const

  server.registerTool(
    'search',
    {
      title: 'Search notes and code',
      description:
        'Hybrid keyword + semantic search over the personal knowledge index (Obsidian notes, GitHub repos, Google Keep). ' +
        'Returns ranked chunks with path, heading path and a snippet. Use get_document to read a whole result.',
      inputSchema: searchInputSchema,
      annotations: readOnly,
    },
    (input) =>
      guard(async () => {
        const response = await search.search(input)
        return text({ degraded: response.degraded, results: response.results.map(resultView) })
      }, log),
  )

  server.registerTool(
    'get_document',
    {
      title: 'Read a document',
      description:
        'Full text of one indexed document by source kind and path (from a search result). ' +
        '`name` picks the source when several of that kind hold the path (repos).',
      inputSchema: documentLookupSchema,
      annotations: readOnly,
    },
    (input) =>
      guard(async () => {
        const doc = await search.findDocument(input.source, input.name ?? null, input.path)
        if (doc === null) return toolError(`No ${input.source} document at ${input.path}`)
        return text({
          ...infoView(doc),
          truncated: doc.truncated,
          totalChars: doc.totalChars,
          content: doc.allowLlm ? doc.content : WITHHELD_TEXT,
        })
      }, log),
  )

  server.registerTool(
    'recent_changes',
    {
      title: 'Recently changed documents',
      description: 'Documents modified in the last `days` days (default 7), newest first, optionally for one source kind.',
      inputSchema: recentInputSchema,
      annotations: readOnly,
    },
    (input) =>
      guard(async () => {
        const documents = await search.recent(input)
        return text({ documents: documents.map(infoView) })
      }, log),
  )

  if (repos !== undefined) {
    server.registerTool(
      'list_repos',
      {
        title: 'List indexed repos',
        description:
          'Every indexed personal GitHub repo with its file and chunk counts. ' +
          'Use a name with get_repo_overview, or as the `repo` filter of search.',
        annotations: readOnly,
      },
      () =>
        guard(async () => {
          const list = await repos.listRepos()
          return text({ repos: list.map(repoInfoView) })
        }, log),
    )

    server.registerTool(
      'get_repo_overview',
      {
        title: 'Repo overview',
        description:
          "One repo's overview: languages, README excerpt, dependencies and file tree, built from the repo without an LLM.",
        inputSchema: repoOverviewSchema,
        annotations: readOnly,
      },
      (input) =>
        guard(async () => {
          const overview = await repos.getOverview(input.name)
          if (overview === null) return toolError(`No indexed repo named ${input.name}; call list_repos for the names`)
          const summary = overview.summary
          return text({
            ...repoInfoView(overview),
            overview: summary === null ? null : summary.allowLlm ? summary.text : WITHHELD_TEXT,
          })
        }, log),
    )
  }

  return server
}

/**
 * `POST /mcp` in stateless Streamable HTTP mode with plain JSON responses.
 * There are no sessions, so `GET` (server stream) and `DELETE` answer 405.
 * The bearer check sits in front of this router (`createApp`).
 */
export function createMcpRouter(
  search: SearchService,
  log: (line: string) => void = console.error,
  repos?: RepoService,
): Router {
  const router = express.Router()
  router.use((_req, res, next) => {
    res.set('cache-control', 'no-store')
    next()
  })

  router.post('/', express.json({ limit: '64kb' }), async (req, res) => {
    const server = buildMcpServer(search, log, repos)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })

  router.all('/', (_req, res) => {
    res.set('allow', 'POST')
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  })

  return router
}

import { apiFetch } from './client'
import type { SourceRef } from './search'

// Mirrors `GET /api/documents/:id/graph` (LocalGraphResponse in server/src/search/graphService.ts).

export type GraphNodeType = 'document' | 'tag' | 'repo' | 'ghost'
/** `link`: a wikilink, embed or Markdown note link; `tag`: a tag or Keep label; `repo`: a repo's map document. */
export type GraphEdgeKind = 'link' | 'tag' | 'repo' | 'neighbour'

export interface GraphNode {
  /** `doc:<id>`, `tag:<key>`, `repo:<source id>` or `ghost:<source id>:<key>`. */
  id: string
  type: GraphNodeType
  /** Title, tag, repo name or the ghost link as written. */
  label: string
  /** Set for documents only. */
  documentId: number | null
  /** The document's or ghost's source, or the repo itself; null for tags. */
  source: SourceRef | null
  sourceLabel: string | null
  /** Set for documents only. */
  path: string | null
  /** Set for documents only. */
  allowLlm: boolean | null
  /** Edges of this node in the response. */
  links: number
}

export interface LocalGraphNode extends GraphNode {
  /** Steps from the opened document. */
  depth: 0 | 1 | 2
}

export interface GraphEdge {
  /** Linking note, tagged document, repo, or the document that lists the neighbour. */
  source: string
  target: string
  kind: GraphEdgeKind
  /** Cosine similarity for `neighbour` edges, else null. */
  score: number | null
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
}

export interface LocalGraphResponse extends GraphResponse {
  documentId: number
  /** False for a document outside the map (repo code, boilerplate, no stored chunks): no graph. */
  inMap: boolean
  /** Node id of the opened document. */
  center: string
  nodes: LocalGraphNode[]
}

export async function getVaultGraph(filters: { sources?: readonly string[]; repo?: string }, signal?: AbortSignal): Promise<GraphResponse> {
  const params = new URLSearchParams()
  if (filters.sources?.length) params.set('sources', filters.sources.join(','))
  if (filters.repo) params.set('repo', filters.repo)
  const query = params.size ? `?${params.toString()}` : ''
  const res = await apiFetch(`/api/graph${query}`, { signal })
  return (await res.json()) as GraphResponse
}

export async function getLocalGraph(id: number, signal?: AbortSignal): Promise<LocalGraphResponse> {
  const res = await apiFetch(`/api/documents/${id}/graph`, { signal })
  return (await res.json()) as LocalGraphResponse
}

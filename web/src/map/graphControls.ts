import type { GraphEdge, GraphNode, GraphResponse } from '../api/graph'

export interface GraphFilters {
  search: string
  showTags: boolean
  showRepos: boolean
  showNeighbours: boolean
  showOrphans: boolean
  existingOnly: boolean
}

export const DEFAULT_GRAPH_FILTERS: GraphFilters = {
  search: '',
  showTags: true,
  showRepos: true,
  showNeighbours: true,
  showOrphans: true,
  existingOnly: false,
}

export interface GraphDisplaySettings {
  arrows: boolean
  /** 0 = sparse (only high-degree/hovered), 1 = balanced, 2 = dense (show most labels). */
  labelDensity: number
  /** Multiplier 0.6 .. 1.8 */
  nodeSize: number
  /** Multiplier 0.5 .. 2.5 */
  linkThickness: number
}

export const DEFAULT_GRAPH_DISPLAY: GraphDisplaySettings = {
  arrows: false,
  labelDensity: 1,
  nodeSize: 1,
  linkThickness: 1,
}

export interface GraphForceSettings {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export const DEFAULT_GRAPH_FORCES: GraphForceSettings = {
  centerForce: 0.35,
  repelForce: 1,
  linkForce: 0.6,
  linkDistance: 95,
}

function matchesSearch(node: GraphNode, q: string): boolean {
  if (node.label.toLocaleLowerCase().includes(q)) return true
  if (node.path !== null && node.path.toLocaleLowerCase().includes(q)) return true
  if (node.type === 'tag' && `#${node.label}`.toLocaleLowerCase().includes(q)) return true
  return false
}

/**
 * Client-side filtering for Whole-Vault and Local graphs (T88) without re-fetching.
 */
export function filterGraph<T extends Pick<GraphResponse, 'nodes' | 'edges'>>(
  graph: T,
  filters: GraphFilters,
  centerId?: string,
): T {
  const q = filters.search.trim().toLocaleLowerCase()
  const baseNodes = graph.nodes.filter((node) => {
    if (!filters.showTags && node.type === 'tag') return false
    if (!filters.showRepos && node.type === 'repo') return false
    if (filters.existingOnly && node.type === 'ghost') return false
    if (q !== '' && node.id !== centerId && !matchesSearch(node, q)) return false
    return true
  })

  const keptIds = new Set(baseNodes.map((node) => node.id))
  const edges: GraphEdge[] = graph.edges.filter((edge) => {
    if (!filters.showNeighbours && edge.kind === 'neighbour') return false
    return keptIds.has(edge.source) && keptIds.has(edge.target)
  })

  if (filters.showOrphans) {
    return { ...graph, nodes: baseNodes, edges }
  }

  const connected = new Set<string>()
  for (const edge of edges) {
    connected.add(edge.source)
    connected.add(edge.target)
  }
  const finalNodes = baseNodes.filter((node) => node.id === centerId || connected.has(node.id))
  return { ...graph, nodes: finalNodes, edges }
}

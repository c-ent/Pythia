import type { GraphEdge, LocalGraphNode, LocalGraphResponse } from '../api/graph'

// Plain data work for the local graph (R20, T71), shared by the list view and
// the Cytoscape canvas. No Cytoscape import here, so the list view and the
// document page never pull the graph library into their chunk.

/** What a node is coloured by: its source for documents, else its node type. */
export type NodeTone = 'obsidian' | 'keep' | 'gdrive' | 'repo' | 'tag' | 'ghost'

export const NODE_TONES: readonly NodeTone[] = ['obsidian', 'keep', 'gdrive', 'repo', 'tag', 'ghost']

export const TONE_LABELS: Record<NodeTone, string> = {
  obsidian: 'Obsidian',
  keep: 'Keep',
  gdrive: 'Drive',
  repo: 'Repo',
  tag: 'Tag',
  ghost: 'Missing note',
}

/** Swatch classes, spelled out so Tailwind generates them (and their CSS variables, read by the canvas). */
export const TONE_SWATCH: Record<NodeTone, string> = {
  obsidian: 'bg-map-obsidian',
  keep: 'bg-map-keep',
  gdrive: 'bg-map-gdrive',
  repo: 'bg-map-repo',
  tag: 'bg-map-tag',
  ghost: 'bg-map-ghost',
}

export function nodeTone(node: Pick<LocalGraphNode, 'type' | 'source'>): NodeTone {
  if (node.type === 'tag') return 'tag'
  if (node.type === 'ghost') return 'ghost'
  if (node.type === 'repo') return 'repo'
  return node.source?.kind ?? 'ghost'
}

/** Node diameter in pixels: grows with the number of links, slowly, and is capped. */
export function nodeSize(links: number): number {
  return Math.round(Math.min(64, 20 + 8 * Math.sqrt(Math.max(0, links))))
}

/** Guards against a server without the graph route answering with something else. */
export function isLocalGraphResponse(value: unknown): value is LocalGraphResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'inMap' in value &&
    typeof value.inMap === 'boolean' &&
    'nodes' in value &&
    Array.isArray(value.nodes) &&
    'edges' in value &&
    Array.isArray(value.edges)
  )
}

/** Nodes other than the opened document. */
export function connectedCount(graph: LocalGraphResponse): number {
  return graph.nodes.filter((node) => node.id !== graph.center).length
}

const TYPE_ORDER: Record<LocalGraphNode['type'], number> = { document: 0, repo: 1, tag: 2, ghost: 3 }

function byImportance(a: LocalGraphNode, b: LocalGraphNode): number {
  return TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || b.links - a.links || a.label.localeCompare(b.label)
}

/** How a node next to the opened document is connected to it, in words. */
function edgePhrase(edge: GraphEdge, node: LocalGraphNode, center: string): string {
  switch (edge.kind) {
    case 'link':
      return edge.source === center ? 'Linked from this note' : 'Links to this note'
    case 'tag':
      return node.type === 'tag' ? 'Tag on this note' : 'Shares a tag'
    case 'repo':
      return node.type === 'repo' ? 'Its repo' : 'Same repo'
    case 'neighbour':
      return 'Similar content'
  }
}

export interface ListEntry {
  node: LocalGraphNode
  tone: NodeTone
  /** Why the node is in the graph: its connection to the document, or the nodes it is reached through. */
  reason: string
}

export interface ListGroup {
  depth: 1 | 2
  title: string
  entries: ListEntry[]
}

const MAX_VIA = 2

/**
 * The list alternative to the graph: one group per step out, each sorted
 * documents first, then by number of links. A 1-step node says how it is
 * connected; a 2-step node names the 1-step nodes it is reached through.
 */
export function listGroups(graph: LocalGraphResponse): ListGroup[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const adjacent = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    for (const id of [edge.source, edge.target]) {
      const list = adjacent.get(id)
      if (list === undefined) adjacent.set(id, [edge])
      else list.push(edge)
    }
  }

  const reason = (node: LocalGraphNode): string => {
    const edges = adjacent.get(node.id) ?? []
    if (node.depth === 1) {
      const phrases = edges
        .filter((edge) => edge.source === graph.center || edge.target === graph.center)
        .map((edge) => edgePhrase(edge, node, graph.center))
      return [...new Set(phrases)].join(' · ')
    }
    const via = [
      ...new Set(
        edges
          .map((edge) => byId.get(edge.source === node.id ? edge.target : edge.source))
          .filter((other): other is LocalGraphNode => other !== undefined && other.depth === 1)
          .sort(byImportance)
          .map((other) => other.label),
      ),
    ]
    if (via.length === 0) return ''
    const shown = via.slice(0, MAX_VIA).join(', ')
    return via.length > MAX_VIA ? `Via ${shown} and ${via.length - MAX_VIA} more` : `Via ${shown}`
  }

  const groups: ListGroup[] = []
  for (const depth of [1, 2] as const) {
    const entries = graph.nodes
      .filter((node) => node.depth === depth && node.id !== graph.center)
      .sort(byImportance)
      .map((node) => ({ node, tone: nodeTone(node), reason: reason(node) }))
    if (entries.length > 0) groups.push({ depth, title: depth === 1 ? 'Connected directly' : 'Two steps away', entries })
  }
  return groups
}

/** Tones present in the graph, in legend order. */
export function tonesIn(graph: LocalGraphResponse): NodeTone[] {
  const present = new Set(graph.nodes.map(nodeTone))
  return NODE_TONES.filter((tone) => present.has(tone))
}

const MAX_LABEL = 32

export function shortLabel(label: string): string {
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

export interface GraphElementData {
  id: string
  label?: string
  tone?: NodeTone
  type?: LocalGraphNode['type']
  size?: number
  center?: 'yes' | 'no'
  source?: string
  target?: string
  kind?: GraphEdge['kind']
}

/** Cytoscape element definitions; edges to nodes the response does not have are dropped. */
export function toElements(graph: LocalGraphResponse): Array<{ group: 'nodes' | 'edges'; data: GraphElementData }> {
  const ids = new Set(graph.nodes.map((node) => node.id))
  const nodes = graph.nodes.map((node) => ({
    group: 'nodes' as const,
    data: {
      id: node.id,
      label: shortLabel(node.label),
      tone: nodeTone(node),
      type: node.type,
      size: node.id === graph.center ? Math.max(nodeSize(node.links), 36) : nodeSize(node.links),
      center: node.id === graph.center ? ('yes' as const) : ('no' as const),
    },
  }))
  const edges = graph.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
    .map((edge, index) => ({
      group: 'edges' as const,
      data: { id: `edge:${index}`, source: edge.source, target: edge.target, kind: edge.kind },
    }))
  return [...nodes, ...edges]
}

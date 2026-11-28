import type { GraphEdge, GraphNode, GraphResponse } from '../api/graph'
import { DEFAULT_GRAPH_FORCES, type GraphForceSettings } from './graphControls'

export interface Node2D {
  id: string
  node: GraphNode
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  isCenter: boolean
}

export interface Layout2D {
  nodes: Node2D[]
  edges: GraphEdge[]
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

/**
 * Deterministic 2D force-directed network layout for Whole-Vault and Local
 * graphs (T89, T90), parameterized by Forces controls.
 */
export function buildForce2DLayout(
  graph: Pick<GraphResponse, 'nodes' | 'edges'>,
  forces: GraphForceSettings = DEFAULT_GRAPH_FORCES,
  centerId?: string,
  jitter = 0,
): Layout2D {
  const count = graph.nodes.length
  if (count === 0) return { nodes: [], edges: [] }

  const nodes: Node2D[] = graph.nodes.map((node, index) => {
    const isCenter = centerId !== undefined && node.id === centerId
    const angle = (index / Math.max(1, count)) * Math.PI * 2 + hashSeed(node.id) * 0.8 + jitter * 0.7
    const dist = isCenter ? 0 : forces.linkDistance * (0.7 + hashSeed(`${node.id}:r`) * 1.1)
    return {
      id: node.id,
      node,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      vx: 0,
      vy: 0,
      radius: isCenter ? 10 : Math.min(11, 4.5 + Math.sqrt(Math.max(0, node.links)) * 1.35),
      isCenter,
    }
  })

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const validEdges = graph.edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target))

  const iterations = Math.min(110, Math.max(40, 120 - Math.floor(count / 4)))
  const repelStrength = 1600 * Math.max(0.1, forces.repelForce)
  const linkStrength = 0.06 * Math.max(0.05, forces.linkForce)
  const centerStrength = 0.04 * Math.max(0.02, forces.centerForce)
  const targetDist = Math.max(30, forces.linkDistance)

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / (iterations + 10)

    // Repulsion (O(n^2) capped safely for interactive vault graphs)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distSq = dx * dx + dy * dy
        if (distSq < 1) {
          dx = 0.5
          dy = 0.5
          distSq = 0.5
        }
        const dist = Math.sqrt(distSq)
        const force = (repelStrength / distSq) * cooling
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        if (!a.isCenter) {
          a.vx -= fx
          a.vy -= fy
        }
        if (!b.isCenter) {
          b.vx += fx
          b.vy += fy
        }
      }
    }

    // Spring attraction along edges
    for (const edge of validEdges) {
      const a = byId.get(edge.source)!
      const b = byId.get(edge.target)!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy))
      const force = (dist - targetDist) * linkStrength * cooling
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      if (!a.isCenter) {
        a.vx += fx
        a.vy += fy
      }
      if (!b.isCenter) {
        b.vx -= fx
        b.vy -= fy
      }
    }

    // Center gravity & integration
    for (const n of nodes) {
      if (n.isCenter) {
        n.x = 0
        n.y = 0
        n.vx = 0
        n.vy = 0
        continue
      }
      n.vx -= n.x * centerStrength * cooling
      n.vy -= n.y * centerStrength * cooling
      n.vx *= 0.72
      n.vy *= 0.72
      n.x += Math.max(-28, Math.min(28, n.vx))
      n.y += Math.max(-28, Math.min(28, n.vy))
    }
  }

  return { nodes, edges: validEdges }
}

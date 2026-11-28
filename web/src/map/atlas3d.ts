import type { GraphEdgeKind, GraphNode, GraphResponse, LocalGraphNode } from '../api/graph'
import { nodeTone, shortLabel, type NodeTone } from './graphModel'
import type { VisibleTopicBranch } from './topicMapModel'

export type AtlasNodeKind = 'center' | 'branch' | 'subbranch' | 'document' | 'tag' | 'repo' | 'ghost'
export type AtlasTone = NodeTone | 'center' | 'branch'

export interface AtlasNode {
  id: string
  kind: AtlasNodeKind
  tone: AtlasTone
  label: string
  sublabel?: string
  x: number
  y: number
  z: number
  radius: number
  links: number
  documentId: number | null
  branchQuery?: string
  sourceLabel: string | null
  path: string | null
  allowLlm: boolean | null
}

export interface AtlasEdge {
  source: string
  target: string
  kind: 'branch' | 'leaf' | GraphEdgeKind
}

export interface AtlasGraph {
  nodes: AtlasNode[]
  edges: AtlasEdge[]
  worldRadius: number
}

export interface Camera3D {
  yaw: number
  pitch: number
  zoom: number
  panX: number
  panY: number
}

export interface ProjectedNode {
  node: AtlasNode
  sx: number
  sy: number
  rz: number
  scale: number
  depthNorm: number
  screenRadius: number
}

export interface StarPoint {
  x: number
  y: number
  z: number
  size: number
  alpha: number
}

export interface PlacedLabel {
  node: ProjectedNode
  x1: number
  y1: number
  x2: number
  y2: number
  text: string
  subtext?: string
  uppercase: boolean
  priority: number
}

export const DEFAULT_CAMERA: Camera3D = {
  yaw: 0.42,
  pitch: -0.22,
  zoom: 1,
  panX: 0,
  panY: 0,
}

export const MIN_ZOOM = 0.35
export const MAX_ZOOM = 4.5

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

interface Vec3 {
  x: number
  y: number
  z: number
}

function normalize(x: number, y: number, z: number): Vec3 {
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) return { x: 0, y: 1, z: 0 }
  return { x: x / len, y: y / len, z: z / len }
}

function orthonormalBasis(dir: Vec3): { u: Vec3; v: Vec3 } {
  const ref = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const u = normalize(
    dir.y * ref.z - dir.z * ref.y,
    dir.z * ref.x - dir.x * ref.z,
    dir.x * ref.y - dir.y * ref.x,
  )
  const v = normalize(
    dir.y * u.z - dir.z * u.y,
    dir.z * u.x - dir.x * u.z,
    dir.x * u.y - dir.y * u.x,
  )
  return { u, v }
}

function sphereDirections(count: number): Vec3[] {
  if (count <= 0) return []
  if (count === 1) return [normalize(0.25, 0.35, 0.9)]
  if (count === 2) return [normalize(-0.85, 0.35, 0.38), normalize(0.85, -0.35, -0.38)]
  const dirs: Vec3[] = []
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = i * GOLDEN_ANGLE
    dirs.push(normalize(Math.cos(theta) * r, y, Math.sin(theta) * r))
  }
  return dirs
}

function conePoints(anchor: Vec3, dir: Vec3, count: number, baseDist: number, spreadAngle: number): Vec3[] {
  if (count <= 0) return []
  const { u, v } = orthonormalBasis(dir)
  const points: Vec3[] = []
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : (i + 0.5) / count
    const angle = count === 1 ? 0 : spreadAngle * Math.sqrt(t)
    const phi = i * GOLDEN_ANGLE
    const sinA = Math.sin(angle)
    const cosA = Math.cos(angle)
    const radialScale = baseDist * (0.86 + 0.28 * ((i % 3) / 2))
    const offsetDir = normalize(
      dir.x * cosA + (u.x * Math.cos(phi) + v.x * Math.sin(phi)) * sinA,
      dir.y * cosA + (u.y * Math.cos(phi) + v.y * Math.sin(phi)) * sinA,
      dir.z * cosA + (u.z * Math.cos(phi) + v.z * Math.sin(phi)) * sinA,
    )
    points.push({
      x: anchor.x + offsetDir.x * radialScale,
      y: anchor.y + offsetDir.y * radialScale,
      z: anchor.z + offsetDir.z * radialScale,
    })
  }
  return points
}

function relaxNodes3d(
  nodes: AtlasNode[],
  edges: readonly AtlasEdge[],
  fixedIds: ReadonlySet<string>,
  iterations: number,
  minDistance: number,
  edgeTarget: number,
): void {
  if (nodes.length <= 1) return
  const byId = new Map(nodes.map((node, index) => [node.id, index]))
  const restPositions = nodes.map((node) => ({ x: node.x, y: node.y, z: node.z }))
  const dispX = new Float64Array(nodes.length)
  const dispY = new Float64Array(nodes.length)
  const dispZ = new Float64Array(nodes.length)

  for (let step = 0; step < iterations; step++) {
    dispX.fill(0)
    dispY.fill(0)
    dispZ.fill(0)

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let dz = a.z - b.z
        let dist = Math.hypot(dx, dy, dz)
        if (dist < 0.01) {
          dx = 0.5 + ((i * 7 + j) % 5) * 0.1
          dy = -0.3 + ((i + j * 3) % 5) * 0.1
          dz = 0.4 - ((i * 2 + j) % 5) * 0.1
          dist = Math.hypot(dx, dy, dz)
        }
        if (dist < minDistance * 1.9) {
          const force = ((minDistance * minDistance) / (dist * dist + 24)) * 0.55
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          const fz = (dz / dist) * force
          if (!fixedIds.has(a.id)) {
            dispX[i]! += fx
            dispY[i]! += fy
            dispZ[i]! += fz
          }
          if (!fixedIds.has(b.id)) {
            dispX[j]! -= fx
            dispY[j]! -= fy
            dispZ[j]! -= fz
          }
        }
      }
    }

    for (const edge of edges) {
      const ia = byId.get(edge.source)
      const ib = byId.get(edge.target)
      if (ia === undefined || ib === undefined) continue
      const a = nodes[ia]!
      const b = nodes[ib]!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist < 0.01) continue
      const pull = ((dist - edgeTarget) / dist) * 0.09
      if (!fixedIds.has(a.id)) {
        dispX[ia]! += dx * pull
        dispY[ia]! += dy * pull
        dispZ[ia]! += dz * pull
      }
      if (!fixedIds.has(b.id)) {
        dispX[ib]! -= dx * pull
        dispY[ib]! -= dy * pull
        dispZ[ib]! -= dz * pull
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      if (fixedIds.has(node.id)) continue
      const rest = restPositions[i]!
      dispX[i]! += (rest.x - node.x) * 0.16
      dispY[i]! += (rest.y - node.y) * 0.16
      dispZ[i]! += (rest.z - node.z) * 0.16
      const maxMove = 10
      node.x += clamp(dispX[i]!, -maxMove, maxMove)
      node.y += clamp(dispY[i]!, -maxMove, maxMove)
      node.z += clamp(dispZ[i]!, -maxMove, maxMove)
    }
  }
}

function countBranchDocuments(branch: VisibleTopicBranch): number {
  const childTotal = branch.branches?.reduce((sum, child) => sum + countBranchDocuments(child), 0) ?? 0
  return branch.documents.length + childTotal
}

function disambiguateTitle(
  title: string,
  path: string,
  sourceName: string,
  titleCounts: ReadonlyMap<string, number>,
): string {
  const lower = title.toLocaleLowerCase()
  const duplicate = (titleCounts.get(lower) ?? 0) > 1
  const generic = lower === 'readme.md' || lower === 'index.md' || lower === 'readme'
  if (!duplicate && !generic) return shortLabel(title)
  const parts = path.split('/').filter(Boolean)
  const folder = parts.length > 1 ? parts[parts.length - 2] : ''
  const prefix = sourceName || folder
  if (prefix) return shortLabel(`${prefix} / ${title}`)
  return shortLabel(title)
}

function computeWorldRadius(nodes: readonly AtlasNode[], minimum = 180): number {
  let maxR = minimum
  for (const node of nodes) {
    const r = Math.hypot(node.x, node.y, node.z)
    if (r > maxR) maxR = r
  }
  return maxR + 24
}

/**
 * Converts a Topic Map tree into a 3D constellation graph where branches fan out
 * evenly in 3D space and leaf nodes occupy a generous 3D cone so labels never pile up.
 */
export function buildTopicAtlasGraph(topic: string, branches: readonly VisibleTopicBranch[]): AtlasGraph {
  const nodes: AtlasNode[] = []
  const edges: AtlasEdge[] = []
  const fixedIds = new Set<string>(['topic:center'])

  const titleCounts = new Map<string, number>()
  const collectTitles = (list: readonly VisibleTopicBranch[]): void => {
    for (const branch of list) {
      for (const doc of branch.documents) {
        const key = doc.title.toLocaleLowerCase()
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)
      }
      if (branch.branches) collectTitles(branch.branches)
    }
  }
  collectTitles(branches)

  const totalDocs = branches.reduce((sum, branch) => sum + countBranchDocuments(branch), 0)
  nodes.push({
    id: 'topic:center',
    kind: 'center',
    tone: 'center',
    label: shortLabel(topic),
    sublabel: `${totalDocs} ${totalDocs === 1 ? 'doc' : 'docs'}`,
    x: 0,
    y: 0,
    z: 0,
    radius: 13,
    links: totalDocs,
    documentId: null,
    sourceLabel: 'Topic root',
    path: null,
    allowLlm: null,
  })

  const branchDirs = sphereDirections(branches.length)
  const branchDist = branches.length <= 3 ? 105 : 122

  branches.forEach((branch, branchIdx) => {
    const dir = branchDirs[branchIdx]!
    const branchId = `branch:${branchIdx}:${branch.label}`
    const branchPos: Vec3 = { x: dir.x * branchDist, y: dir.y * branchDist, z: dir.z * branchDist }
    const branchDocsCount = countBranchDocuments(branch)

    nodes.push({
      id: branchId,
      kind: 'branch',
      tone: 'branch',
      label: shortLabel(branch.label),
      sublabel: `${branchDocsCount} ${branchDocsCount === 1 ? 'doc' : 'docs'}`,
      x: branchPos.x,
      y: branchPos.y,
      z: branchPos.z,
      radius: 9.5,
      links: branchDocsCount,
      documentId: null,
      branchQuery: branch.locked ? undefined : branch.label,
      sourceLabel: branch.locked ? 'Private topic group' : 'Topic branch',
      path: null,
      allowLlm: !branch.locked,
    })
    edges.push({ source: 'topic:center', target: branchId, kind: 'branch' })

    const addLeaves = (parentId: string, parentPos: Vec3, parentDir: Vec3, leaves: typeof branch.documents): void => {
      if (leaves.length === 0) return
      const leafDist = 66 + Math.sqrt(leaves.length) * 14
      const spread = Math.min(1.18, 0.42 + Math.sqrt(leaves.length) * 0.22)
      const positions = conePoints(parentPos, parentDir, leaves.length, leafDist, spread)
      leaves.forEach((doc, leafIdx) => {
        const pos = positions[leafIdx]!
        const nodeId = `doc:${doc.documentId}:${branchIdx}:${leafIdx}`
        nodes.push({
          id: nodeId,
          kind: 'document',
          tone: doc.source.kind,
          label: disambiguateTitle(doc.title, doc.path, doc.source.name, titleCounts),
          x: pos.x,
          y: pos.y,
          z: pos.z,
          radius: 5.5,
          links: 1,
          documentId: doc.documentId,
          sourceLabel: doc.source.name || doc.source.kind,
          path: doc.path,
          allowLlm: doc.allowLlm,
        })
        edges.push({ source: parentId, target: nodeId, kind: 'leaf' })
      })
    }

    if (branch.branches && branch.branches.length > 0) {
      const subPositions = conePoints(branchPos, dir, branch.branches.length, 64, Math.min(1.05, 0.45 + branch.branches.length * 0.14))
      branch.branches.forEach((sub, subIdx) => {
        const subPos = subPositions[subIdx]!
        const subDir = normalize(subPos.x - branchPos.x, subPos.y - branchPos.y, subPos.z - branchPos.z)
        const subId = `subbranch:${branchIdx}:${subIdx}:${sub.label}`
        nodes.push({
          id: subId,
          kind: 'subbranch',
          tone: 'branch',
          label: shortLabel(sub.label),
          sublabel: `${sub.documents.length} ${sub.documents.length === 1 ? 'doc' : 'docs'}`,
          x: subPos.x,
          y: subPos.y,
          z: subPos.z,
          radius: 7.5,
          links: sub.documents.length,
          documentId: null,
          branchQuery: sub.locked ? undefined : sub.label,
          sourceLabel: sub.locked ? 'Private topic group' : 'Sub-branch',
          path: null,
          allowLlm: !sub.locked,
        })
        edges.push({ source: branchId, target: subId, kind: 'branch' })
        addLeaves(subId, subPos, subDir, sub.documents)
      })
    }

    addLeaves(branchId, branchPos, dir, branch.documents)
  })

  relaxNodes3d(nodes, edges, fixedIds, 36, 36, 72)

  return {
    nodes,
    edges,
    worldRadius: computeWorldRadius(nodes, 185),
  }
}

function isLocalNode(node: GraphNode): node is LocalGraphNode {
  return 'depth' in node && typeof (node as LocalGraphNode).depth === 'number'
}

/**
 * Converts a local or whole-vault GraphResponse into a 3D force-directed Atlas graph.
 */
export function buildNetworkAtlasGraph(graph: Pick<GraphResponse, 'nodes' | 'edges'>, center?: string): AtlasGraph {
  const ordered = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set(ordered.map((node) => node.id))
  const count = ordered.length

  const nodes: AtlasNode[] = ordered.map((node, index) => {
    const tone = nodeTone(node)
    const isCenter = node.id === center
    const seed = hashString(node.id)
    const localDepth = isLocalNode(node) ? node.depth : 1

    let x = 0
    let y = 0
    let z = 0
    if (!isCenter) {
      const dirs = sphereDirections(Math.max(1, count - (center ? 1 : 0)))
      const dir = dirs[index % dirs.length]!
      const shell = center ? (localDepth === 1 ? 92 : 162) : 85 + Math.sqrt(count) * 11
      const jitter = 0.78 + 0.44 * seededUnit(seed)
      x = dir.x * shell * jitter
      y = dir.y * shell * jitter
      z = dir.z * shell * jitter
    }

    const baseRadius = isCenter
      ? 12.5
      : node.type === 'repo' || node.type === 'tag'
        ? clamp(5.5 + Math.sqrt(Math.max(0, node.links)) * 1.4, 6, 11)
        : clamp(4.2 + Math.sqrt(Math.max(0, node.links)) * 1.15, 4.5, 10)

    return {
      id: node.id,
      kind: isCenter ? 'center' : node.type,
      tone: isCenter ? 'center' : tone,
      label: node.type === 'tag' ? `#${shortLabel(node.label)}` : shortLabel(node.label),
      sublabel: node.type === 'repo' || node.type === 'tag' ? `${node.links} ${node.links === 1 ? 'link' : 'links'}` : undefined,
      x,
      y,
      z,
      radius: baseRadius,
      links: node.links,
      documentId: node.documentId,
      sourceLabel: node.sourceLabel,
      path: node.path,
      allowLlm: node.allowLlm,
    }
  })

  const edges: AtlasEdge[] = graph.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target)
    .map((edge) => ({ source: edge.source, target: edge.target, kind: edge.kind }))

  const fixedIds = new Set<string>(center ? [center] : [])
  const byId = new Map(nodes.map((node, index) => [node.id, index]))
  const n = nodes.length

  if (n > 1) {
    const iterations = n > 260 ? 32 : n > 120 ? 52 : 76
    const idealRepel = 56 + Math.sqrt(n) * 3.2
    const dispX = new Float64Array(n)
    const dispY = new Float64Array(n)
    const dispZ = new Float64Array(n)

    for (let step = 0; step < iterations; step++) {
      dispX.fill(0)
      dispY.fill(0)
      dispZ.fill(0)
      const cooling = 1 - step / (iterations + 8)

      // For very large graphs, stride pairs slightly on later iterations to keep frame setup instant.
      const stride = n > 320 ? 2 : 1
      for (let i = 0; i < n; i++) {
        const a = nodes[i]!
        for (let j = i + 1 + (step % stride); j < n; j += stride) {
          const b = nodes[j]!
          let dx = a.x - b.x
          let dy = a.y - b.y
          let dz = a.z - b.z
          let dist = Math.hypot(dx, dy, dz)
          if (dist < 0.01) {
            dx = 0.6
            dy = -0.4
            dz = 0.5
            dist = Math.hypot(dx, dy, dz)
          }
          const force = ((idealRepel * idealRepel) / (dist * dist + 140)) * 0.42 * stride
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          const fz = (dz / dist) * force
          if (!fixedIds.has(a.id)) {
            dispX[i]! += fx
            dispY[i]! += fy
            dispZ[i]! += fz
          }
          if (!fixedIds.has(b.id)) {
            dispX[j]! -= fx
            dispY[j]! -= fy
            dispZ[j]! -= fz
          }
        }
      }

      for (const edge of edges) {
        const ia = byId.get(edge.source)
        const ib = byId.get(edge.target)
        if (ia === undefined || ib === undefined) continue
        const a = nodes[ia]!
        const b = nodes[ib]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dz = b.z - a.z
        const dist = Math.hypot(dx, dy, dz)
        if (dist < 0.01) continue
        const ideal = edge.kind === 'neighbour' ? 92 : 68
        const pull = ((dist - ideal) / dist) * 0.14
        if (!fixedIds.has(a.id)) {
          dispX[ia]! += dx * pull
          dispY[ia]! += dy * pull
          dispZ[ia]! += dz * pull
        }
        if (!fixedIds.has(b.id)) {
          dispX[ib]! -= dx * pull
          dispY[ib]! -= dy * pull
          dispZ[ib]! -= dz * pull
        }
      }

      for (let i = 0; i < n; i++) {
        const node = nodes[i]!
        if (fixedIds.has(node.id)) continue
        dispX[i]! -= node.x * 0.032
        dispY[i]! -= node.y * 0.032
        dispZ[i]! -= node.z * 0.032
        const maxMove = 12 * cooling + 1.5
        node.x += clamp(dispX[i]!, -maxMove, maxMove)
        node.y += clamp(dispY[i]!, -maxMove, maxMove)
        node.z += clamp(dispZ[i]!, -maxMove, maxMove)
      }
    }

    // Center the cloud around origin when there is no pinned center node.
    if (!center) {
      let mx = 0
      let my = 0
      let mz = 0
      for (const node of nodes) {
        mx += node.x
        my += node.y
        mz += node.z
      }
      mx /= n
      my /= n
      mz /= n
      for (const node of nodes) {
        node.x -= mx
        node.y -= my
        node.z -= mz
      }
    }

    // Normalize scale so any vault size fills the 3D sphere consistently.
    let maxDist = 1
    for (const node of nodes) {
      const d = Math.hypot(node.x, node.y, node.z)
      if (d > maxDist) maxDist = d
    }
    const targetRadius = n <= 8 ? 130 : 185
    const scale = targetRadius / maxDist
    for (const node of nodes) {
      node.x *= scale
      node.y *= scale
      node.z *= scale
    }
  }

  return {
    nodes,
    edges,
    worldRadius: computeWorldRadius(nodes, 170),
  }
}

export function rotatePoint(x: number, y: number, z: number, yaw: number, pitch: number): { rx: number; ry: number; rz: number } {
  const cosY = Math.cos(yaw)
  const sinY = Math.sin(yaw)
  const x1 = x * cosY - z * sinY
  const z1 = x * sinY + z * cosY

  const cosP = Math.cos(pitch)
  const sinP = Math.sin(pitch)
  const y2 = y * cosP - z1 * sinP
  const z2 = y * sinP + z1 * cosP

  return { rx: x1, ry: y2, rz: z2 }
}

export function projectPoint(
  x: number,
  y: number,
  z: number,
  camera: Camera3D,
  width: number,
  height: number,
  worldRadius: number,
): { sx: number; sy: number; rz: number; scale: number; depthNorm: number } {
  const { rx, ry, rz } = rotatePoint(x, y, z, camera.yaw, camera.pitch)
  const baseScale = Math.min(width, height) / (worldRadius * 2.45)
  const fov = 720
  const perspective = fov / Math.max(150, fov - rz * 0.65)
  const scale = perspective * camera.zoom * baseScale
  const sx = width / 2 + camera.panX + rx * scale
  const sy = height / 2 + camera.panY - ry * scale
  const depthNorm = clamp((rz + worldRadius) / (2 * worldRadius), 0, 1)
  return { sx, sy, rz, scale, depthNorm }
}

export function projectNodes(
  nodes: readonly AtlasNode[],
  camera: Camera3D,
  width: number,
  height: number,
  worldRadius: number,
): ProjectedNode[] {
  const projected = nodes.map((node) => {
    const p = projectPoint(node.x, node.y, node.z, camera, width, height, worldRadius)
    const depthScale = 0.68 + 0.52 * p.depthNorm
    const screenRadius = clamp(node.radius * (0.65 + 0.35 * camera.zoom) * depthScale, 2.5, 28)
    return {
      node,
      sx: p.sx,
      sy: p.sy,
      rz: p.rz,
      scale: p.scale,
      depthNorm: p.depthNorm,
      screenRadius,
    }
  })
  // Painter's algorithm: farthest first.
  projected.sort((a, b) => a.rz - b.rz)
  return projected
}

export function generateStarfield(count = 190, seed = 101): StarPoint[] {
  const stars: StarPoint[] = []
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = i * GOLDEN_ANGLE + seededUnit(seed + i * 3) * 0.35
    const dist = 230 + seededUnit(seed + i * 7) * 190
    stars.push({
      x: Math.cos(theta) * r * dist,
      y: y * dist,
      z: Math.sin(theta) * r * dist,
      size: 0.6 + seededUnit(seed + i * 11) * 1.15,
      alpha: 0.08 + seededUnit(seed + i * 13) * 0.28,
    })
  }
  return stars
}

export function hitTestProjected(projected: readonly ProjectedNode[], px: number, py: number): ProjectedNode | null {
  // Iterate front-to-back so closer nodes win over background nodes.
  for (let i = projected.length - 1; i >= 0; i--) {
    const item = projected[i]!
    const hitRadius = Math.max(14, item.screenRadius + 6)
    const dx = px - item.sx
    const dy = py - item.sy
    if (dx * dx + dy * dy <= hitRadius * hitRadius) return item
  }
  return null
}

function rectsOverlap(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
  marginX: number,
  marginY: number,
): boolean {
  return !(a.x2 + marginX < b.x1 || b.x2 + marginX < a.x1 || a.y2 + marginY < b.y1 || b.y2 + marginY < a.y1)
}

function labelPriority(
  item: ProjectedNode,
  hoveredId: string | null,
  neighborIds: ReadonlySet<string>,
): number {
  if (item.node.id === hoveredId) return 1000
  if (neighborIds.has(item.node.id)) return 750 + item.depthNorm * 50
  if (item.node.kind === 'center') return 650
  if (item.node.kind === 'branch' || item.node.kind === 'subbranch') return 520 + item.depthNorm * 40
  if (item.node.kind === 'repo' || item.node.kind === 'tag') return 360 + item.node.links * 6 + item.depthNorm * 30
  return 100 + Math.min(80, item.node.links * 8) + item.depthNorm * 45
}

/**
 * Selects non-overlapping labels in priority order, reserving HUD corners so labels
 * never collide with each other or with the zoom controls / axis gizmo.
 */
export function selectVisibleLabels(
  projected: readonly ProjectedNode[],
  width: number,
  height: number,
  hoveredId: string | null,
  neighborIds: ReadonlySet<string>,
  measureTextWidth: (text: string, uppercase: boolean) => number,
): PlacedLabel[] {
  const candidates = projected
    .filter((item) => item.sx >= 16 && item.sx <= width - 16 && item.sy >= 52 && item.sy <= height - 18)
    .map((item) => ({
      item,
      priority: labelPriority(item, hoveredId, neighborIds),
    }))
    .sort((a, b) => b.priority - a.priority)

  // Reserve HUD zones: top bar, top-right zoom stack, bottom-right axis gizmo.
  const occupied: Array<{ x1: number; y1: number; x2: number; y2: number }> = [
    { x1: 0, y1: 0, x2: width, y2: 52 },
    { x1: Math.max(0, width - 76), y1: 0, x2: width, y2: 205 },
    { x1: Math.max(0, width - 96), y1: Math.max(0, height - 96), x2: width, y2: height },
  ]

  const placed: PlacedLabel[] = []
  for (const { item, priority } of candidates) {
    const uppercase = item.node.kind === 'center' || item.node.kind === 'branch' || item.node.kind === 'subbranch'
    const text = uppercase ? item.node.label.toLocaleUpperCase() : item.node.label
    const subtext = uppercase ? item.node.sublabel : undefined
    const textWidth = Math.max(measureTextWidth(text, uppercase), subtext ? measureTextWidth(subtext, false) : 0)
    const boxHeight = subtext ? 26 : 15
    const anchorY = item.sy + item.screenRadius + 6

    const box = {
      x1: item.sx - textWidth / 2 - 4,
      y1: anchorY,
      x2: item.sx + textWidth / 2 + 4,
      y2: anchorY + boxHeight,
    }

    if (box.x1 < 8 || box.x2 > width - 8 || box.y2 > height - 8) continue
    if (occupied.some((other) => rectsOverlap(box, other, 8, 5))) continue

    occupied.push(box)
    placed.push({
      node: item,
      x1: box.x1,
      y1: box.y1,
      x2: box.x2,
      y2: box.y2,
      text,
      subtext,
      uppercase,
      priority,
    })
  }

  return placed
}

import type { SourceKind } from '../api/search'
import type { PartitionedTopicMap, VisibleTopicBranch } from './topicMapModel'

export type MindmapSide = 'left' | 'right'

export interface MindmapNode {
  id: string
  label: string
  fullLabel: string
  kind: 'root' | 'branch' | 'document'
  side: MindmapSide | 'center'
  color: string
  x: number
  y: number
  width: number
  /** Junction x where outgoing curves to children start (on the outer edge of the label). */
  outX: number
  /** Junction x where incoming curve from parent attaches. */
  inX: number
  documentId: number | null
  branchQuery: string | null
  sourceKind: SourceKind | null
  path: string | null
  allowLlm: boolean | null
  hasChildren: boolean
  collapsed: boolean
  childCount: number
  children: MindmapNode[]
}

export interface MindmapEdge {
  id: string
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: string
}

export interface MindmapLayout {
  root: MindmapNode
  edges: MindmapEdge[]
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number }
}

const BRANCH_COLORS = [
  '#60a5fa', // blue
  '#4ade80', // green
  '#f472b6', // pink
  '#f5b454', // amber
  '#a78bfa', // lavender
  '#2dd4bf', // teal
  '#fb7185', // coral
  '#a3e635', // lime
]

const ROOT_HEIGHT = 42
const ROW_HEIGHT = 30
const BRANCH_GAP = 14
const LEVEL_GAP_ROOT = 72
const LEVEL_GAP = 54
const MAX_LABEL_CHARS = 36

function truncateLabel(text: string): string {
  const clean = text.trim()
  if (clean.length <= MAX_LABEL_CHARS) return clean
  return `${clean.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
}

function estimateTextWidth(text: string, isRoot = false): number {
  const perChar = isRoot ? 8.6 : 7.2
  const padding = isRoot ? 28 : 10
  return Math.max(isRoot ? 84 : 36, Math.round(text.length * perChar + padding))
}

interface RawTreeItem {
  id: string
  label: string
  fullLabel: string
  kind: 'branch' | 'document'
  documentId: number | null
  branchQuery: string | null
  sourceKind: SourceKind | null
  path: string | null
  allowLlm: boolean | null
  children: RawTreeItem[]
}

function branchToRaw(branch: VisibleTopicBranch, path: string): RawTreeItem {
  const children: RawTreeItem[] = [
    ...(branch.branches?.map((child, idx) => branchToRaw(child, `${path}/b${idx}`)) ?? []),
    ...branch.documents.map((doc) => ({
      id: `${path}/d${doc.documentId}`,
      label: truncateLabel(doc.title),
      fullLabel: doc.title,
      kind: 'document' as const,
      documentId: doc.documentId,
      branchQuery: null,
      sourceKind: doc.source.kind,
      path: doc.path,
      allowLlm: doc.allowLlm,
      children: [],
    })),
  ]
  return {
    id: path,
    label: truncateLabel(branch.label),
    fullLabel: branch.label,
    kind: 'branch',
    documentId: null,
    branchQuery: branch.label,
    sourceKind: null,
    path: null,
    allowLlm: null,
    children,
  }
}

function countLeaves(item: RawTreeItem): number {
  if (item.children.length === 0) return 1
  return item.children.reduce((sum, child) => sum + countLeaves(child), 0)
}

function subtreeHeight(item: RawTreeItem, collapsedIds?: ReadonlySet<string>): number {
  if (item.children.length === 0 || collapsedIds?.has(item.id)) return ROW_HEIGHT
  const childrenSum = item.children.reduce((sum, child) => sum + subtreeHeight(child, collapsedIds), 0)
  return Math.max(ROW_HEIGHT, childrenSum + Math.max(0, item.children.length - 1) * 4)
}

function layoutSubtree(
  item: RawTreeItem,
  side: MindmapSide,
  color: string,
  parentOutX: number,
  centerY: number,
  edges: MindmapEdge[],
  isTopLevel: boolean,
  collapsedIds?: ReadonlySet<string>,
): MindmapNode {
  const width = estimateTextWidth(item.label)
  const gap = isTopLevel ? LEVEL_GAP_ROOT : LEVEL_GAP
  const hasChildren = item.children.length > 0
  const collapsed = hasChildren && Boolean(collapsedIds?.has(item.id))

  const inX = side === 'right' ? parentOutX + gap : parentOutX - gap
  const x = side === 'right' ? inX : inX - width
  const outX = side === 'right' ? inX + width + 8 : inX - width - 8

  const children: MindmapNode[] = []
  if (hasChildren && !collapsed) {
    const totalH = subtreeHeight(item, collapsedIds)
    let cursorY = centerY - totalH / 2
    for (let i = 0; i < item.children.length; i++) {
      const child = item.children[i]!
      const childH = subtreeHeight(child, collapsedIds)
      const childCenterY = cursorY + childH / 2
      const childNode = layoutSubtree(child, side, color, outX, childCenterY, edges, false, collapsedIds)
      children.push(childNode)
      edges.push({
        id: `${item.id}->${child.id}`,
        fromX: outX,
        fromY: centerY,
        toX: childNode.inX,
        toY: childCenterY,
        color,
      })
      cursorY += childH + 4
    }
  }

  return {
    id: item.id,
    label: item.label,
    fullLabel: item.fullLabel,
    kind: item.kind,
    side,
    color,
    x,
    y: centerY,
    width,
    outX,
    inX,
    documentId: item.documentId,
    branchQuery: item.branchQuery,
    sourceKind: item.sourceKind,
    path: item.path,
    allowLlm: item.allowLlm,
    hasChildren,
    collapsed,
    childCount: hasChildren ? countLeaves(item) : 0,
    children,
  }
}

/**
 * Builds a balanced left/right 2D horizontal mindmap layout from a partitioned
 * topic map, matching classic Markmap-style branching curves.
 */
export function buildTopicMindmapLayout(
  topic: string,
  partitioned: PartitionedTopicMap,
  collapsedIds?: ReadonlySet<string>,
): MindmapLayout {
  const rootLabel = truncateLabel(topic)
  const rootWidth = estimateTextWidth(rootLabel, true)
  const rootLeftX = -rootWidth / 2
  const rootRightX = rootWidth / 2

  const topItems: RawTreeItem[] = [
    ...partitioned.branches.map((branch, idx) => branchToRaw(branch, `b${idx}`)),
    ...partitioned.directDocuments.map((doc) => ({
      id: `direct-${doc.documentId}`,
      label: truncateLabel(doc.title),
      fullLabel: doc.title,
      kind: 'document' as const,
      documentId: doc.documentId,
      branchQuery: null,
      sourceKind: doc.source.kind,
      path: doc.path,
      allowLlm: doc.allowLlm,
      children: [],
    })),
  ]

  // Balance arms between right and left sides by leaf weight (right first for small maps).
  const rightItems: Array<{ item: RawTreeItem; color: string }> = []
  const leftItems: Array<{ item: RawTreeItem; color: string }> = []
  let rightWeight = 0
  let leftWeight = 0

  topItems.forEach((item, idx) => {
    const color = BRANCH_COLORS[idx % BRANCH_COLORS.length]!
    const weight = countLeaves(item)
    if (rightWeight <= leftWeight) {
      rightItems.push({ item, color })
      rightWeight += weight
    } else {
      leftItems.push({ item, color })
      leftWeight += weight
    }
  })

  const edges: MindmapEdge[] = []
  const rootChildren: MindmapNode[] = []

  const placeSide = (items: Array<{ item: RawTreeItem; color: string }>, side: MindmapSide): void => {
    if (items.length === 0) return
    const heights = items.map((entry) => subtreeHeight(entry.item, collapsedIds))
    const totalH = heights.reduce((sum, h) => sum + h, 0) + Math.max(0, items.length - 1) * BRANCH_GAP
    let cursorY = -totalH / 2
    const originX = side === 'right' ? rootRightX : rootLeftX

    items.forEach((entry, idx) => {
      const h = heights[idx]!
      const cy = cursorY + h / 2
      const node = layoutSubtree(entry.item, side, entry.color, originX, cy, edges, true, collapsedIds)
      rootChildren.push(node)
      edges.push({
        id: `root->${entry.item.id}`,
        fromX: originX,
        fromY: 0,
        toX: node.inX,
        toY: cy,
        color: entry.color,
      })
      cursorY += h + BRANCH_GAP
    })
  }

  placeSide(rightItems, 'right')
  placeSide(leftItems, 'left')

  const root: MindmapNode = {
    id: 'root',
    label: rootLabel,
    fullLabel: topic,
    kind: 'root',
    side: 'center',
    color: '#f2f5fa',
    x: rootLeftX,
    y: 0,
    width: rootWidth,
    outX: rootRightX,
    inX: rootLeftX,
    documentId: null,
    branchQuery: null,
    sourceKind: null,
    path: null,
    allowLlm: null,
    hasChildren: rootChildren.length > 0,
    collapsed: false,
    childCount: rootChildren.length,
    children: rootChildren,
  }

  let minX = rootLeftX - 24
  let maxX = rootRightX + 24
  let minY = -ROOT_HEIGHT / 2 - 24
  let maxY = ROOT_HEIGHT / 2 + 24

  const visit = (node: MindmapNode): void => {
    minX = Math.min(minX, node.x - 24)
    maxX = Math.max(maxX, node.x + node.width + 24)
    minY = Math.min(minY, node.y - ROW_HEIGHT / 2 - 18)
    maxY = Math.max(maxY, node.y + ROW_HEIGHT / 2 + 18)
    for (const child of node.children) visit(child)
  }
  visit(root)

  return {
    root,
    edges,
    bounds: {
      minX,
      maxX,
      minY,
      maxY,
      width: Math.max(240, maxX - minX),
      height: Math.max(160, maxY - minY),
    },
  }
}

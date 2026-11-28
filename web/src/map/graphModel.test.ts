import { describe, expect, it } from 'vitest'
import type { GraphEdge, LocalGraphNode, LocalGraphResponse } from '../api/graph'
import { connectedCount, isLocalGraphResponse, listGroups, nodeSize, nodeTone, shortLabel, toElements, tonesIn } from './graphModel'

const node = (over: Partial<LocalGraphNode> & Pick<LocalGraphNode, 'id'>): LocalGraphNode => ({
  type: 'document',
  label: over.id,
  documentId: null,
  source: { kind: 'obsidian', name: 'vault' },
  sourceLabel: 'Obsidian',
  path: null,
  allowLlm: true,
  links: 1,
  depth: 1,
  ...over,
})

const edge = (source: string, target: string, kind: GraphEdge['kind'] = 'link'): GraphEdge => ({
  source,
  target,
  kind,
  score: kind === 'neighbour' ? 0.7 : null,
})

const graph = (nodes: LocalGraphNode[], edges: GraphEdge[]): LocalGraphResponse => ({
  documentId: 7,
  inMap: true,
  center: 'doc:7',
  nodes,
  edges,
  truncated: false,
})

const center = node({ id: 'doc:7', label: 'Pythia', documentId: 7, depth: 0, links: 4 })

describe('nodeTone', () => {
  it('colours documents by source and the rest by type', () => {
    expect(nodeTone({ type: 'document', source: { kind: 'keep', name: 'keep' } })).toBe('keep')
    expect(nodeTone({ type: 'document', source: { kind: 'gdrive', name: 'drive' } })).toBe('gdrive')
    expect(nodeTone({ type: 'document', source: { kind: 'repo', name: 'pythia' } })).toBe('repo')
    expect(nodeTone({ type: 'repo', source: { kind: 'repo', name: 'pythia' } })).toBe('repo')
    expect(nodeTone({ type: 'tag', source: null })).toBe('tag')
    expect(nodeTone({ type: 'ghost', source: { kind: 'obsidian', name: 'vault' } })).toBe('ghost')
  })
})

describe('nodeSize', () => {
  it('grows with links and is capped', () => {
    expect(nodeSize(0)).toBe(20)
    expect(nodeSize(4)).toBeGreaterThan(nodeSize(1))
    expect(nodeSize(10_000)).toBe(64)
    expect(nodeSize(-3)).toBe(20)
  })
})

describe('isLocalGraphResponse', () => {
  it('accepts the graph shape and rejects anything else', () => {
    expect(isLocalGraphResponse(graph([center], []))).toBe(true)
    expect(isLocalGraphResponse({ related: [] })).toBe(false)
    expect(isLocalGraphResponse(null)).toBe(false)
    expect(isLocalGraphResponse({ inMap: true, nodes: [] })).toBe(false)
  })
})

describe('listGroups', () => {
  const keep = node({ id: 'doc:9', label: 'Bread', documentId: 9, source: { kind: 'keep', name: 'keep' }, sourceLabel: 'Keep' })
  const tag = node({ id: 'tag:baking', type: 'tag', label: 'baking', source: null, sourceLabel: null, links: 3 })
  const ghost = node({ id: 'ghost:1:sourdough', type: 'ghost', label: 'Sourdough', links: 1 })
  const far = node({ id: 'doc:12', label: 'Oven', documentId: 12, depth: 2 })
  const g = graph(
    [center, tag, ghost, keep, far],
    [
      edge('doc:7', 'doc:9', 'neighbour'),
      edge('doc:7', 'tag:baking', 'tag'),
      edge('doc:7', 'ghost:1:sourdough'),
      edge('doc:12', 'tag:baking', 'tag'),
      edge('doc:9', 'doc:12', 'neighbour'),
    ],
  )

  it('groups by step, documents first, and leaves the opened document out', () => {
    const groups = listGroups(g)
    expect(groups.map((group) => group.title)).toEqual(['Connected directly', 'Two steps away'])
    expect(groups[0]!.entries.map((entry) => entry.node.id)).toEqual(['doc:9', 'tag:baking', 'ghost:1:sourdough'])
    expect(groups[1]!.entries.map((entry) => entry.node.id)).toEqual(['doc:12'])
    expect(connectedCount(g)).toBe(4)
  })

  it('says how each node is connected', () => {
    const [direct, twoSteps] = listGroups(g)
    const reasons = Object.fromEntries(direct!.entries.map((entry) => [entry.node.id, entry.reason]))
    expect(reasons).toEqual({
      'doc:9': 'Similar content',
      'tag:baking': 'Tag on this note',
      'ghost:1:sourdough': 'Linked from this note',
    })
    expect(twoSteps!.entries[0]!.reason).toBe('Via Bread, baking')
  })

  it('names a link back as a backlink and ignores edges to nodes it does not have', () => {
    const back = node({ id: 'doc:3', label: 'Index', documentId: 3 })
    const groups = listGroups(graph([center, back], [edge('doc:3', 'doc:7'), edge('doc:3', 'doc:404')]))
    expect(groups[0]!.entries[0]!.reason).toBe('Links to this note')
  })

  it('is empty when nothing is connected', () => {
    expect(listGroups(graph([center], []))).toEqual([])
  })
})

describe('toElements and tonesIn', () => {
  it('builds nodes and edges, dropping edges to missing nodes', () => {
    const tag = node({ id: 'tag:a', type: 'tag', label: 'a', source: null, sourceLabel: null })
    const elements = toElements(graph([center, tag], [edge('doc:7', 'tag:a', 'tag'), edge('doc:7', 'doc:404')]))
    expect(elements.filter((element) => element.group === 'nodes')).toHaveLength(2)
    expect(elements.filter((element) => element.group === 'edges')).toHaveLength(1)
    expect(elements.find((element) => element.data.id === 'doc:7')?.data.center).toBe('yes')
    expect(tonesIn(graph([center, tag], []))).toEqual(['obsidian', 'tag'])
  })

  it('shortens long labels', () => {
    expect(shortLabel('short')).toBe('short')
    expect(shortLabel('x'.repeat(50))).toHaveLength(32)
  })
})

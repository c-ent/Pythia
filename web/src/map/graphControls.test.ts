import { describe, expect, it } from 'vitest'
import type { GraphResponse } from '../api/graph'
import { buildForce2DLayout } from './force2d'
import { DEFAULT_GRAPH_FILTERS, DEFAULT_GRAPH_FORCES, filterGraph } from './graphControls'

const sampleGraph: GraphResponse = {
  nodes: [
    { id: 'doc:1', type: 'document', label: 'Alpha Note', documentId: 1, source: { kind: 'obsidian', name: 'vault' }, sourceLabel: 'Obsidian', path: 'Notes/Alpha.md', allowLlm: true, links: 3 },
    { id: 'doc:2', type: 'document', label: 'Beta Guide', documentId: 2, source: { kind: 'repo', name: 'pythia' }, sourceLabel: 'pythia', path: 'docs/Beta.md', allowLlm: true, links: 1 },
    { id: 'tag:focus', type: 'tag', label: 'focus', documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 1 },
    { id: 'repo:1', type: 'repo', label: 'pythia', documentId: null, source: { kind: 'repo', name: 'pythia' }, sourceLabel: 'pythia', path: null, allowLlm: null, links: 1 },
    { id: 'ghost:missing', type: 'ghost', label: 'Missing Note', documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 1 },
    { id: 'doc:9', type: 'document', label: 'Lonely Note', documentId: 9, source: { kind: 'keep', name: 'keep' }, sourceLabel: 'Keep', path: 'Lonely.md', allowLlm: true, links: 0 },
  ],
  edges: [
    { source: 'doc:1', target: 'doc:2', kind: 'neighbour', score: 0.8 },
    { source: 'doc:1', target: 'tag:focus', kind: 'tag', score: null },
    { source: 'repo:1', target: 'doc:2', kind: 'repo', score: null },
    { source: 'doc:1', target: 'ghost:missing', kind: 'link', score: null },
  ],
  truncated: false,
}

describe('filterGraph', () => {
  it('filters tags, repos, semantic neighbours, ghosts, orphans, and search text without mutating source', () => {
    const noTagsRepos = filterGraph(sampleGraph, { ...DEFAULT_GRAPH_FILTERS, showTags: false, showRepos: false })
    expect(noTagsRepos.nodes.some((n) => n.type === 'tag' || n.type === 'repo')).toBe(false)

    const noNeighbours = filterGraph(sampleGraph, { ...DEFAULT_GRAPH_FILTERS, showNeighbours: false })
    expect(noNeighbours.edges.some((e) => e.kind === 'neighbour')).toBe(false)

    const existingOnly = filterGraph(sampleGraph, { ...DEFAULT_GRAPH_FILTERS, existingOnly: true })
    expect(existingOnly.nodes.some((n) => n.type === 'ghost')).toBe(false)

    const noOrphans = filterGraph(sampleGraph, { ...DEFAULT_GRAPH_FILTERS, showOrphans: false })
    expect(noOrphans.nodes.some((n) => n.id === 'doc:9')).toBe(false)

    const searchTag = filterGraph(sampleGraph, { ...DEFAULT_GRAPH_FILTERS, search: '#focus' }, 'doc:1')
    expect(searchTag.nodes.map((n) => n.id)).toEqual(['doc:1', 'tag:focus'])
  })
})

describe('buildForce2DLayout', () => {
  it('places the center node at the origin and lays out connected nodes deterministically', () => {
    const first = buildForce2DLayout(sampleGraph, DEFAULT_GRAPH_FORCES, 'doc:1')
    const second = buildForce2DLayout(sampleGraph, DEFAULT_GRAPH_FORCES, 'doc:1')
    expect(first.nodes.find((n) => n.id === 'doc:1')).toMatchObject({ x: 0, y: 0, isCenter: true })
    expect(first).toEqual(second)

    const wider = buildForce2DLayout(sampleGraph, { ...DEFAULT_GRAPH_FORCES, linkDistance: 180 }, 'doc:1')
    expect(wider.nodes).not.toEqual(first.nodes)
  })
})

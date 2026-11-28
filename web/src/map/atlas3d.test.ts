import { describe, expect, it } from 'vitest'
import type { GraphResponse } from '../api/graph'
import {
  buildNetworkAtlasGraph,
  buildTopicAtlasGraph,
  DEFAULT_CAMERA,
  hitTestProjected,
  projectNodes,
  selectVisibleLabels,
} from './atlas3d'
import { safeTopicBranches } from './topicMapModel'

const makeDoc = (documentId: number, title: string, sourceKind: 'obsidian' | 'repo' = 'obsidian', sourceName = 'vault', allowLlm = true) => ({
  documentId,
  source: { kind: sourceKind, name: sourceName },
  path: `${sourceName}/${title}`,
  title,
  allowLlm,
})

describe('buildTopicAtlasGraph', () => {
  it('spreads dense branches in 3D without overlapping nodes and disambiguates duplicate READMEs', () => {
    const branches = safeTopicBranches([
      {
        label: 'just · not',
        documents: Array.from({ length: 10 }, (_, idx) => makeDoc(idx + 1, `Career Note ${idx + 1}`)),
      },
      {
        label: 'account · add',
        documents: [
          makeDoc(20, 'README.md', 'repo', 'alpha'),
          makeDoc(21, 'README.md', 'repo', 'beta'),
          makeDoc(22, 'Readme.md', 'repo', 'gamma'),
        ],
      },
    ])

    const atlas = buildTopicAtlasGraph('job', branches)
    const center = atlas.nodes.find((n) => n.kind === 'center')
    expect(center).toBeDefined()
    expect(center?.x).toBe(0)
    expect(center?.y).toBe(0)
    expect(center?.z).toBe(0)

    // All 13 leaf nodes should be well separated in 3D space.
    const leaves = atlas.nodes.filter((n) => n.kind === 'document')
    expect(leaves).toHaveLength(13)
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i]!
        const b = leaves[j]!
        const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
        expect(dist).toBeGreaterThan(15)
      }
    }

    const labels = leaves.map((n) => n.label)
    expect(labels).toContain('alpha / README.md')
    expect(labels).toContain('beta / README.md')
    expect(labels).toContain('gamma / Readme.md')
  })

  it('keeps locked branch labels hidden and omits branchQuery for locked branches', () => {
    const branches = safeTopicBranches([
      { label: 'secret topic', documents: [makeDoc(1, 'Private', 'obsidian', 'vault', false)] },
      { label: 'public topic', documents: [makeDoc(2, 'Public', 'obsidian', 'vault', true)] },
    ])
    const atlas = buildTopicAtlasGraph('focus', branches)
    const branchNodes = atlas.nodes.filter((n) => n.kind === 'branch')
    expect(branchNodes.map((n) => n.label)).toEqual(['Topic 1', 'public topic'])
    expect(branchNodes[0]?.branchQuery).toBeUndefined()
    expect(branchNodes[1]?.branchQuery).toBe('public topic')
  })
})

describe('buildNetworkAtlasGraph', () => {
  it('anchors the center node and ignores edges to missing nodes', () => {
    const graph: GraphResponse = {
      nodes: [
        { id: 'doc:1', type: 'document', label: 'Center', documentId: 1, source: { kind: 'obsidian', name: 'vault' }, sourceLabel: 'Obsidian', path: 'Center.md', allowLlm: true, links: 2 },
        { id: 'doc:2', type: 'document', label: 'Linked', documentId: 2, source: { kind: 'repo', name: 'pythia' }, sourceLabel: 'pythia', path: 'README.md', allowLlm: true, links: 1 },
        { id: 'tag:dev', type: 'tag', label: 'dev', documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 1 },
      ],
      edges: [
        { source: 'doc:1', target: 'doc:2', kind: 'neighbour', score: 0.8 },
        { source: 'doc:1', target: 'tag:dev', kind: 'tag', score: null },
        { source: 'doc:1', target: 'doc:404', kind: 'link', score: null },
      ],
      truncated: false,
    }

    const atlas = buildNetworkAtlasGraph(graph, 'doc:1')
    expect(atlas.edges).toHaveLength(2)
    const center = atlas.nodes.find((n) => n.id === 'doc:1')
    expect(center?.x).toBe(0)
    expect(center?.y).toBe(0)
    expect(center?.z).toBe(0)
    expect(atlas.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))).toBe(true)
  })
})

describe('projection, hit testing and label collision culling', () => {
  it('culls overlapping labels so placed labels never collide with each other or HUD corners', () => {
    const branches = safeTopicBranches([
      {
        label: 'dense',
        documents: Array.from({ length: 18 }, (_, i) => makeDoc(i + 1, `Very Long Document Title ${i + 1}`)),
      },
    ])
    const atlas = buildTopicAtlasGraph('job', branches)
    const projected = projectNodes(atlas.nodes, DEFAULT_CAMERA, 760, 520, atlas.worldRadius)

    const placed = selectVisibleLabels(
      projected,
      760,
      520,
      null,
      new Set(),
      (text) => text.length * 6.5,
    )

    expect(placed.length).toBeGreaterThan(0)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!
        const b = placed[j]!
        const overlaps = !(a.x2 + 8 < b.x1 || b.x2 + 8 < a.x1 || a.y2 + 5 < b.y1 || b.y2 + 5 < a.y1)
        expect(overlaps).toBe(false)
      }
    }

    const centerProjected = projected.find((p) => p.node.kind === 'center')!
    const hit = hitTestProjected(projected, centerProjected.sx, centerProjected.sy)
    expect(hit?.node.id).toBe('topic:center')
  })
})

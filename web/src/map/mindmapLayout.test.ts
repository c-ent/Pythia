import { describe, expect, it } from 'vitest'
import { buildTopicMindmapLayout } from './mindmapLayout'
import type { PartitionedTopicMap } from './topicMapModel'

describe('buildTopicMindmapLayout', () => {
  it('balances branches across left and right sides with edges and bounds', () => {
    const partitioned: PartitionedTopicMap = {
      directDocuments: [],
      branches: [
        {
          label: 'Courses',
          locked: false,
          documents: [
            { documentId: 1, title: 'LYT Course MOC', path: 'LYT.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          ],
        },
        {
          label: 'Ideation',
          locked: false,
          documents: [
            { documentId: 2, title: 'Idea Circle TK', path: 'Idea.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          ],
        },
        {
          label: 'Interests',
          locked: false,
          documents: [
            { documentId: 3, title: 'Interests MOC', path: 'Interests.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
            { documentId: 4, title: 'Futurism MOC', path: 'Futurism.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          ],
        },
      ],
    }

    const layout = buildTopicMindmapLayout('000 Home', partitioned)
    expect(layout.root.label).toBe('000 Home')
    expect(layout.root.children).toHaveLength(3)
    expect(layout.root.children.some((node) => node.side === 'right')).toBe(true)
    expect(layout.root.children.some((node) => node.side === 'left')).toBe(true)
    expect(layout.edges.length).toBe(3 + 4)
    expect(layout.bounds.width).toBeGreaterThan(240)
    expect(layout.bounds.height).toBeGreaterThanOrEqual(160)
  })

  it('places direct documents when there are no branches', () => {
    const partitioned: PartitionedTopicMap = {
      directDocuments: [
        { documentId: 10, title: 'Ikigai', path: 'Ikigai.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
      ],
      branches: [],
    }

    const layout = buildTopicMindmapLayout('ikigai', partitioned)
    expect(layout.root.children).toHaveLength(1)
    expect(layout.root.children[0]?.kind).toBe('document')
    expect(layout.root.children[0]?.documentId).toBe(10)
    expect(layout.edges).toHaveLength(1)
  })

  it('hides child nodes and edges when a branch is collapsed in-place', () => {
    const partitioned: PartitionedTopicMap = {
      directDocuments: [],
      branches: [
        {
          label: 'Interests',
          locked: false,
          documents: [
            { documentId: 3, title: 'Interests MOC', path: 'Interests.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
            { documentId: 4, title: 'Futurism MOC', path: 'Futurism.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
          ],
        },
      ],
    }

    const expanded = buildTopicMindmapLayout('000 Home', partitioned)
    expect(expanded.edges).toHaveLength(3)
    expect(expanded.root.children[0]?.children).toHaveLength(2)

    const collapsed = buildTopicMindmapLayout('000 Home', partitioned, new Set(['b0']))
    expect(collapsed.edges).toHaveLength(1)
    expect(collapsed.root.children[0]?.collapsed).toBe(true)
    expect(collapsed.root.children[0]?.children).toHaveLength(0)
  })
})

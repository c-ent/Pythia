import { describe, expect, it } from 'vitest'
import { drillContext, filterTopicBranches, mapMemory, resetMapMemory } from './map'
import type { VisibleTopicBranch } from '../map/topicMapModel'

const branches: VisibleTopicBranch[] = [
  {
    label: 'Architecture',
    locked: false,
    documents: [
      { documentId: 1, title: 'Deep Modules', path: 'notes/deep.md', source: { kind: 'obsidian', name: 'vault' }, allowLlm: true },
    ],
    branches: [
      {
        label: 'Postgres',
        locked: false,
        documents: [
          { documentId: 2, title: 'RRF Search', path: 'server/search.md', source: { kind: 'repo', name: 'pythia' }, allowLlm: true },
        ],
      },
    ],
  },
  {
    label: 'Cooking',
    locked: false,
    documents: [
      { documentId: 3, title: 'Sourdough', path: 'keep/bread.md', source: { kind: 'keep', name: 'keep' }, allowLlm: true },
    ],
  },
]

describe('map session helpers', () => {
  it('formats drill-down context cleanly', () => {
    expect(drillContext([])).toBeUndefined()
    expect(drillContext(['Architecture'])).toBe('Architecture')
    expect(drillContext(['Architecture', 'Postgres'])).toBe('Architecture · Postgres')
    expect(drillContext(['Architecture', 'Postgres', 'HNSW'])).toBe('Architecture · HNSW')
  })

  it('filters topic branches by branch label, document title, or path', () => {
    expect(filterTopicBranches(branches, '')).toHaveLength(2)
    expect(filterTopicBranches(branches, 'cooking')).toHaveLength(1)
    const nested = filterTopicBranches(branches, 'server/search')
    expect(nested).toHaveLength(1)
    expect(nested[0].branches).toHaveLength(1)
    expect(nested[0].branches?.[0].label).toBe('Postgres')
  })

  it('resets mapMemory fields', () => {
    mapMemory.topic = 'test'
    mapMemory.attempt = 3
    resetMapMemory()
    expect(mapMemory.topic).toBe('')
    expect(mapMemory.attempt).toBe(0)
  })
})

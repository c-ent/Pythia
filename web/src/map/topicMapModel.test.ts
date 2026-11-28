import { describe, expect, it } from 'vitest'
import type { TopicMapResponse } from '../api/topicMap'
import { partitionTopicMap, safeTopicBranches, topicMapDocuments, topicMapOutline } from './topicMapModel'

const doc = (documentId: number, allowLlm: boolean) => ({
  documentId,
  source: { kind: 'obsidian' as const, name: 'vault' },
  path: `Note ${documentId}.md`,
  title: `Note ${documentId}`,
  allowLlm,
})

const response: TopicMapResponse = {
  topic: 'knowledge maps',
  branches: [
    { label: 'public words', documents: [doc(1, true), doc(2, false)] },
    { label: 'safe branch', documents: [doc(3, true)], branches: [{ label: 'locked words', documents: [doc(4, false)] }] },
  ],
}

describe('topicMapModel', () => {
  it('replaces labels for any branch containing locked documents, including parent labels', () => {
    const branches = safeTopicBranches(response.branches)
    expect(branches.map((branch) => branch.label)).toEqual(['Topic 1', 'Topic 2'])
    expect(branches[1]?.branches?.[0]?.label).toBe('Topic 2 1')
    expect(branches[0]?.locked).toBe(true)
  })

  it('includes nested documents and builds a safe Markdown outline', () => {
    expect(topicMapDocuments(safeTopicBranches(response.branches)).map((document) => document.documentId)).toEqual([1, 2, 3, 4])
    expect(topicMapOutline(response)).toContain('- Topic 1\n    - Note 1')
    expect(topicMapOutline(response)).not.toContain('public words')
    expect(topicMapOutline(response)).not.toContain('locked words')
  })

  it('attaches maps with 3 or fewer docs directly under the topic root', () => {
    const single: TopicMapResponse = {
      topic: 'ikigai',
      branches: [{ label: 'Ikigai', documents: [doc(1, true)] }],
    }
    const partitioned = partitionTopicMap(safeTopicBranches(single.branches))
    expect(partitioned.branches).toEqual([])
    expect(partitioned.directDocuments.map((d) => d.documentId)).toEqual([1])
    expect(topicMapOutline(single)).toBe('ikigai\n  - Note 1 (obsidian: Note 1.md)')

    const threeDocs: TopicMapResponse = {
      topic: 'small',
      branches: [
        { label: 'Group A', documents: [doc(1, true), doc(2, true)] },
        { label: 'Group B', documents: [doc(3, true)] },
      ],
    }
    const partitionedThree = partitionTopicMap(safeTopicBranches(threeDocs.branches))
    expect(partitionedThree.branches).toEqual([])
    expect(partitionedThree.directDocuments.map((d) => d.documentId)).toEqual([1, 2, 3])
  })

  it('keeps multi-doc branches, lifts 1-doc branches to direct center docs, and lifts 1-doc subbranches', () => {
    const branches = safeTopicBranches([
      {
        label: 'Main cluster',
        documents: [],
        branches: [
          { label: 'Sub A', documents: [doc(1, true), doc(2, true)] },
          { label: 'Sub B', documents: [doc(3, true)] },
        ],
      },
      { label: 'Singleton', documents: [doc(4, true)] },
    ])
    const partitioned = partitionTopicMap(branches)
    expect(partitioned.directDocuments.map((d) => d.documentId)).toEqual([4])
    expect(partitioned.branches).toHaveLength(1)
    expect(partitioned.branches[0]?.documents.map((d) => d.documentId)).toEqual([3])
    expect(partitioned.branches[0]?.branches?.map((b) => b.label)).toEqual(['Sub A'])
  })
})

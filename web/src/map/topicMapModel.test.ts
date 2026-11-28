import { describe, expect, it } from 'vitest'
import type { TopicMapResponse } from '../api/topicMap'
import { safeTopicBranches, topicMapDocuments, topicMapOutline } from './topicMapModel'

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
})

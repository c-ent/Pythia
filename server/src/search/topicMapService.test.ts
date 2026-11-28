import { describe, expect, it } from 'vitest'
import type { TopicMapCandidate, TopicMapSearchParams, TopicMapStore } from '../db/topicMapStore.js'
import type { Embedder } from '../embed/ollama.js'
import { createTopicMapService, TOPIC_MAP_LIMIT } from './topicMapService.js'

const candidate = (documentId: number): TopicMapCandidate => ({
  documentId,
  sourceKind: documentId % 2 === 0 ? 'obsidian' : 'keep',
  sourceName: documentId % 2 === 0 ? 'vault' : 'keep',
  path: `Notes/Topic ${documentId}.md`,
  title: `Topic Gardening ${documentId}`,
  allowLlm: documentId % 3 !== 0,
  embedding: [1, documentId % 4 === 0 ? 0 : 0.1, 0],
  headingPaths: ['Gardening > Soil'],
  text: 'Healthy soil supports garden plants and seeds.',
})

function fixtureStore(documents: TopicMapCandidate[]) {
  const calls: TopicMapSearchParams[] = []
  const store: TopicMapStore = {
    async search(params) {
      calls.push(params)
      return documents.slice(0, params.limit)
    },
  }
  return { store, calls }
}

const embedder: Embedder = {
  model: 'fixture-model',
  dimensions: 3,
  async embedDocuments() {
    throw new Error('topic maps must not embed documents')
  },
  async embedQuery() {
    return [1, 0, 0]
  },
}

const leaves = (response: Awaited<ReturnType<ReturnType<typeof createTopicMapService>['map']>>) =>
  response.branches.flatMap((branch) =>
    branch.branches === undefined ? branch.documents : branch.branches.flatMap((subbranch) => subbranch.documents),
  )

describe('topic map service', () => {
  it('returns deterministic 3–7 labelled groups from at most 40 filtered map documents', async () => {
    const { store, calls } = fixtureStore(Array.from({ length: 46 }, (_, index) => candidate(index + 1)))
    const service = createTopicMapService({ store, embedder })
    const request = { topic: ' gardening ', sources: ['obsidian', 'keep'] as const, repo: 'my-repo' }
    const first = await service.map(request)
    const second = await service.map(request)

    expect(first).toEqual(second)
    expect(first.topic).toBe('gardening')
    expect(first.branches.length).toBeGreaterThanOrEqual(3)
    expect(first.branches.length).toBeLessThanOrEqual(7)
    expect(first.branches.every((branch) => branch.label.length > 0)).toBe(true)
    expect(leaves(first)).toHaveLength(TOPIC_MAP_LIMIT)
    expect(calls[0]).toMatchObject({
      query: 'gardening',
      filters: { sources: ['obsidian', 'keep'], repo: 'my-repo' },
      candidates: 50,
      limit: 40,
      embedModel: 'fixture-model',
    })
    expect(calls[1]).toEqual(calls[0])
  })

  it('uses stored text only for keyword labels and never needs a chat model', async () => {
    const { store } = fixtureStore([candidate(1), candidate(2), candidate(3)])
    const service = createTopicMapService({ store, embedder })
    const response = await service.map({ topic: 'gardening' })
    expect(response.branches.every((branch) => branch.label.trim().length > 0)).toBe(true)
    expect(leaves(response)).toHaveLength(3)
  })

  it('splits oversized branches into one more level with at most eight leaves per subbranch', async () => {
    const { store } = fixtureStore(Array.from({ length: 40 }, (_, index) => candidate(index + 1)))
    const response = await createTopicMapService({ store, embedder }).map({ topic: 'gardening' })
    for (const branch of response.branches) {
      if (branch.branches !== undefined) {
        expect(branch.documents).toHaveLength(0)
        expect(branch.branches.every((subbranch) => subbranch.documents.length <= 8 && subbranch.label.length > 0)).toBe(true)
      } else {
        expect(branch.documents.length).toBeLessThanOrEqual(8)
      }
    }
  })
})

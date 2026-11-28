import { describe, expect, it } from 'vitest'
import {
  TOPIC_MAP_CONTEXT_MIN_SIMILARITY,
  TOPIC_MAP_MIN_SIMILARITY,
  type TopicMapCandidate,
  type TopicMapSearchParams,
  type TopicMapStore,
} from '../db/topicMapStore.js'
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

  it('weights titles and headings over body filler and avoids same-stem duplicates', async () => {
    const docs: TopicMapCandidate[] = [
      {
        documentId: 1,
        sourceKind: 'obsidian',
        sourceName: 'vault',
        path: 'Ikigai.md',
        title: 'Ikigai Purpose',
        allowLlm: true,
        embedding: [1, 0, 0],
        headingPaths: ['Meaning > Calling'],
        text: 'able able able across across just just 10th 20px achieve achieving achievement',
      },
      {
        documentId: 2,
        sourceKind: 'obsidian',
        sourceName: 'vault',
        path: 'Vocation.md',
        title: 'Craft Vocation',
        allowLlm: true,
        embedding: [0, 1, 0],
        headingPaths: ['Mastery'],
        text: 'able across just open',
      },
    ]
    const { store } = fixtureStore(docs)
    const response = await createTopicMapService({ store, embedder }).map({ topic: 'ikigai' })
    const labels = response.branches.map((branch) => branch.label)
    expect(labels.join(' ')).not.toMatch(/\b(able|across|just|10th|20px)\b/)
    expect(labels[0]).toContain('purpose')
    expect(labels[0]).not.toMatch(/achieve.*achiev/)
  })

  it('anchors embeddings and FTS distance when drilling down with parent context', async () => {
    const embeddedQueries: string[] = []
    const trackingEmbedder: Embedder = {
      ...embedder,
      async embedQuery(text) {
        embeddedQueries.push(text)
        return [1, 0, 0]
      },
    }
    const { store, calls } = fixtureStore([candidate(1)])
    const response = await createTopicMapService({ store, embedder: trackingEmbedder }).map({
      topic: 'purpose · calling',
      context: 'ikigai',
    })

    expect(response.topic).toBe('purpose · calling')
    expect(embeddedQueries).toEqual(['ikigai: purpose calling'])
    expect(calls[0]).toMatchObject({
      query: 'ikigai: purpose calling',
      ftsQuery: 'purpose OR calling',
      maxDistance: 1 - TOPIC_MAP_MIN_SIMILARITY,
      ftsMaxDistance: 1 - TOPIC_MAP_CONTEXT_MIN_SIMILARITY,
    })
  })
})

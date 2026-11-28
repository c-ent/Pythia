import { describe, expect, it } from 'vitest'
import type { RelatedHit, RelatedParams, RelatedStore } from '../db/neighbourStore.js'
import { createRelatedService, MAX_PASSAGE_CHARS, scoreBand } from './relatedService.js'

const hit = (over: Partial<RelatedHit> = {}): RelatedHit => ({
  documentId: 21,
  sourceKind: 'keep',
  sourceName: 'keep',
  path: 'Keep/Garden.json',
  title: 'Garden',
  allowLlm: true,
  score: 0.83,
  passage: { chunkId: 5, headingPath: 'Garden', startLine: null, endLine: null, content: '  Tomatoes need sun.  ' },
  ...over,
})

function fakeStore(lookup: Awaited<ReturnType<RelatedStore['related']>>) {
  const calls: RelatedParams[] = []
  const store: RelatedStore = {
    async related(params) {
      calls.push(params)
      return lookup
    },
  }
  return { store, calls }
}

describe('scoreBand', () => {
  it.each([
    [0.95, 'strong'],
    [0.8, 'strong'],
    [0.79, 'medium'],
    [0.7, 'medium'],
    [0.69, 'weak'],
    [0.6, 'weak'],
  ])('%s is %s', (score, band) => {
    expect(scoreBand(score)).toBe(band)
  })
})

describe('createRelatedService', () => {
  it('returns neighbours with source, band and a trimmed passage', async () => {
    const { store } = fakeStore({ inMap: true, hits: [hit()] })
    const response = await createRelatedService({ store }).related({ documentId: 7 })
    expect(response).toEqual({
      documentId: 7,
      inMap: true,
      related: [
        {
          documentId: 21,
          source: { kind: 'keep', name: 'keep' },
          path: 'Keep/Garden.json',
          title: 'Garden',
          allowLlm: true,
          score: 0.83,
          band: 'strong',
          passage: { chunkId: 5, headingPath: 'Garden', startLine: null, endLine: null, text: 'Tomatoes need sun.', truncated: false },
        },
      ],
    })
  })

  it('caps a long passage', async () => {
    const { store } = fakeStore({ inMap: true, hits: [hit({ passage: { ...hit().passage!, content: 'word '.repeat(500) } })] })
    const response = await createRelatedService({ store }).related({ documentId: 7 })
    const passage = response?.related[0]?.passage
    expect(passage?.truncated).toBe(true)
    expect(passage?.text.length).toBeLessThanOrEqual(MAX_PASSAGE_CHARS)
  })

  it('passes filters to the store and clamps the limit to 8', async () => {
    const { store, calls } = fakeStore({ inMap: true, hits: [] })
    const service = createRelatedService({ store, cutoff: 0.5 })
    await service.related({ documentId: 7, sources: ['keep', 'gdrive'], repo: 'pythia', limit: 3 })
    await service.related({ documentId: 7, limit: 50 })
    await service.related({ documentId: 7 })
    expect(calls).toEqual([
      { documentId: 7, filters: { sources: ['keep', 'gdrive'], repo: 'pythia' }, limit: 3, cutoff: 0.5 },
      { documentId: 7, filters: { sources: undefined, repo: undefined }, limit: 8, cutoff: 0.5 },
      { documentId: 7, filters: { sources: undefined, repo: undefined }, limit: 8, cutoff: 0.5 },
    ])
  })

  it('uses the R20 cut-off of 0.6 by default', async () => {
    const { store, calls } = fakeStore({ inMap: true, hits: [] })
    await createRelatedService({ store }).related({ documentId: 7 })
    expect(calls[0]?.cutoff).toBe(0.6)
  })

  it('says when the document is outside the map, and null when it does not exist', async () => {
    expect(await createRelatedService(fakeStore({ inMap: false, hits: [] })).related({ documentId: 7 })).toEqual({
      documentId: 7,
      inMap: false,
      related: [],
    })
    expect(await createRelatedService(fakeStore(null)).related({ documentId: 7 })).toBeNull()
  })

  it('keeps a neighbour that has no passage in the model', async () => {
    const { store } = fakeStore({ inMap: true, hits: [hit({ passage: null, score: 0.65 })] })
    const response = await createRelatedService({ store }).related({ documentId: 7 })
    expect(response?.related[0]).toMatchObject({ band: 'weak', passage: null })
  })
})

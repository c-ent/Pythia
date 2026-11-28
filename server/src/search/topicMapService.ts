import type { TopicMapStore, TopicMapCandidate } from '../db/topicMapStore.js'
import type { SearchableKind } from '../db/searchStore.js'
import type { Embedder } from '../embed/ollama.js'
import type { SourceRef } from './searchService.js'

export const TOPIC_MAP_CANDIDATES = 50
export const TOPIC_MAP_LIMIT = 40
export const MIN_TOPIC_BRANCHES = 3
export const MAX_TOPIC_BRANCHES = 7
export const MAX_TOPIC_BRANCH_DOCUMENTS = 8

export interface TopicMapRequest {
  topic: string
  sources?: readonly SearchableKind[]
  repo?: string
}

export interface TopicMapLeaf {
  documentId: number
  source: SourceRef
  path: string
  title: string
  allowLlm: boolean
}

export interface TopicMapSubbranch {
  label: string
  documents: TopicMapLeaf[]
}

export interface TopicMapBranch {
  label: string
  documents: TopicMapLeaf[]
  /** Present when this branch held more than eight documents. */
  branches?: TopicMapSubbranch[]
}

export interface TopicMapResponse {
  topic: string
  branches: TopicMapBranch[]
}

export interface TopicMapService {
  map(request: TopicMapRequest): Promise<TopicMapResponse>
}

export interface TopicMapServiceOptions {
  store: TopicMapStore
  embedder: Embedder
}

const STOP_WORDS = new Set(
  `a an and are as at be been being by can could did do does for from had has have how i in into is it its may more most of on or our should that the their then there these they this those to was we were what when where which who why will with would you your about after all also any because before between both but each few first other same such than through under use using`.split(' '),
)
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu

function terms(text: string): string[] {
  return (text.toLocaleLowerCase().match(WORD) ?? [])
    .map((word) => word.replace(/^['_-]+|['_-]+$/g, ''))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word))
}

/** Stable keyword labels: title and headings contribute more than body text. */
function labelFor(documents: readonly TopicMapCandidate[], fallback: string): string {
  const counts = new Map<string, number>()
  for (const document of documents) {
    const weighted = [
      ...terms(document.title),
      ...terms(document.title),
      ...document.headingPaths.flatMap(terms),
      ...document.text.slice(0, 12_000).split(/\s+/).flatMap((word) => terms(word)),
    ]
    for (const word of new Set(weighted)) counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  const top = [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 2)
    .map(([word]) => word)
  return top.length === 0 ? fallback : top.join(' · ')
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return -1
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    aa += av * av
    bb += bv * bv
  }
  return aa === 0 || bb === 0 ? -1 : dot / Math.sqrt(aa * bb)
}

/** Deterministic farthest-first seeded clustering with a fixed iteration count. */
function cluster(documents: readonly TopicMapCandidate[], requested: number): TopicMapCandidate[][] {
  if (documents.length === 0) return []
  const count = Math.min(documents.length, requested)
  const ordered = [...documents].sort((a, b) => a.documentId - b.documentId)
  const seeds: TopicMapCandidate[] = [ordered[0]!]
  while (seeds.length < count) {
    let best: TopicMapCandidate | undefined
    let bestDistance = -Infinity
    for (const candidate of ordered) {
      if (seeds.includes(candidate)) continue
      const nearest = Math.max(...seeds.map((seed) => cosine(candidate.embedding, seed.embedding)))
      const distance = -nearest
      if (distance > bestDistance || (distance === bestDistance && candidate.documentId < (best?.documentId ?? Infinity))) {
        best = candidate
        bestDistance = distance
      }
    }
    if (best === undefined) break
    seeds.push(best)
  }

  let groups: TopicMapCandidate[][] = Array.from({ length: seeds.length }, () => [])
  for (let iteration = 0; iteration < 8; iteration++) {
    groups = Array.from({ length: seeds.length }, () => [])
    for (let i = 0; i < seeds.length; i++) groups[i]!.push(seeds[i]!)
    for (const document of ordered) {
      if (seeds.includes(document)) continue
      let target = 0
      let score = -Infinity
      for (let i = 0; i < seeds.length; i++) {
        const similarity = cosine(document.embedding, seeds[i]!.embedding)
        if (similarity > score || (similarity === score && groups[i]!.length < groups[target]!.length)) {
          score = similarity
          target = i
        }
      }
      groups[target]!.push(document)
    }
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!
      if (group.length === 0) continue
      const medoid = group
        .map((candidate) => ({ candidate, score: group.reduce((sum, other) => sum + cosine(candidate.embedding, other.embedding), 0) }))
        .sort((a, b) => b.score - a.score || a.candidate.documentId - b.candidate.documentId)[0]!
      seeds[i] = medoid.candidate
    }
  }
  return groups.filter((group) => group.length > 0)
}

const toLeaf = (doc: TopicMapCandidate): TopicMapLeaf => ({
  documentId: doc.documentId,
  source: { kind: doc.sourceKind, name: doc.sourceName },
  path: doc.path,
  title: doc.title,
  allowLlm: doc.allowLlm,
})

function makeBranch(documents: readonly TopicMapCandidate[], index: number): TopicMapBranch {
  const label = labelFor(documents, `Topic ${index + 1}`)
  if (documents.length <= MAX_TOPIC_BRANCH_DOCUMENTS) {
    return { label, documents: documents.map(toLeaf) }
  }
  const childCount = Math.ceil(documents.length / MAX_TOPIC_BRANCH_DOCUMENTS)
  const children = cluster(documents, childCount).flatMap((group, groupIndex) => {
    const ordered = [...group].sort((a, b) => a.documentId - b.documentId)
    const parts: TopicMapCandidate[][] = []
    for (let i = 0; i < ordered.length; i += MAX_TOPIC_BRANCH_DOCUMENTS) parts.push(ordered.slice(i, i + MAX_TOPIC_BRANCH_DOCUMENTS))
    return parts.map((part, partIndex) => ({
      label: labelFor(part, `${label} ${groupIndex + 1}.${partIndex + 1}`),
      documents: part.map(toLeaf),
    }))
  })
  return { label, documents: [], branches: children }
}

export function createTopicMapService(options: TopicMapServiceOptions): TopicMapService {
  return {
    async map(request) {
      const topic = request.topic.trim()
      if (topic.length === 0) throw new Error('topic must not be empty')
      const embedding = await options.embedder.embedQuery(topic)
      const documents = await options.store.search({
        query: topic,
        embedding,
        embedModel: options.embedder.model,
        filters: { sources: request.sources, repo: request.repo },
        candidates: TOPIC_MAP_CANDIDATES,
        limit: TOPIC_MAP_LIMIT,
      })
      const branchCount = Math.min(MAX_TOPIC_BRANCHES, Math.max(MIN_TOPIC_BRANCHES, Math.ceil(documents.length / 6)))
      const groups = cluster(documents, branchCount)
      return { topic, branches: groups.map(makeBranch) }
    },
  }
}

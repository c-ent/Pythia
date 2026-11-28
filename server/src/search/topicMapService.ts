import {
  TOPIC_MAP_CONTEXT_MIN_SIMILARITY,
  TOPIC_MAP_DOC_MIN_SIMILARITY,
  TOPIC_MAP_MIN_SIMILARITY,
  TOPIC_MAP_STRONG_SIMILARITY,
  type TopicMapCandidate,
  type TopicMapStore,
} from '../db/topicMapStore.js'
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
  /** Optional parent topic / trail when drilling into a branch so searches stay on-topic. */
  context?: string
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
  (
    'a able about above across add added adding after again against all almost alone along already also although always among an and another any anyone anything anywhere are around as at away ' +
    'back be became because become becomes been before behind being below between beyond big both but by ' +
    'call called came can cannot come comes coming could ' +
    'day days did different do does doing done down during ' +
    'each either else end enough even ever every everyone everything example ' +
    'far feel few file files find first for found from full ' +
    'gave get gets getting give given gives go going good got great ' +
    'had has have having he help her here hers herself high him himself his how however ' +
    'if important in include includes including inside instead into is it its itself ' +
    'just keep kind know known knows ' +
    'large last later least less let like likely little long look looking looks ' +
    'made make makes making many may maybe me mean means might more most mostly much must my myself ' +
    'name near need needed needs never new next no none nor not note notes nothing now number ' +
    'of off often old on once one only open or order other others our ours ourselves out over own ' +
    'part parts people perhaps place point possible put ' +
    'quite rather read readme real really right ' +
    'said same saw say says second see seem seems seen set several she should show shows since small so some something sometimes soon start still such sure ' +
    'take taken takes taking tell than that the their theirs them themselves then there these they thing things think this those though thought three through thus time times to today together too took toward tried try trying turn two ' +
    'under until up upon us use used uses using usually ' +
    'various very want wants was way ways we well went were what when where whether which while who why will with within without word words work working works would ' +
    'year years yet you your yours yourself'
  ).split(' '),
)
const WORD = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu
const STARTS_WITH_LETTER = /^\p{L}/u

function terms(text: string): string[] {
  return (text.toLocaleLowerCase().match(WORD) ?? [])
    .map((word) => word.replace(/^['_-]+|['_-]+$/g, ''))
    .filter((word) => word.length > 2 && STARTS_WITH_LETTER.test(word) && !STOP_WORDS.has(word))
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i++
  return i
}

function sharesStem(a: string, b: string): boolean {
  if (a === b) return true
  const minLen = Math.min(a.length, b.length)
  if (minLen >= 4 && (a.startsWith(b) || b.startsWith(a))) return true
  return minLen >= 6 && commonPrefixLength(a, b) >= 5
}

function documentTermWeights(document: TopicMapCandidate): Map<string, number> {
  const weights = new Map<string, number>()
  const addField = (words: readonly string[], weight: number): void => {
    for (const word of new Set(words)) {
      weights.set(word, (weights.get(word) ?? 0) + weight)
    }
  }
  addField(terms(document.title), 4)
  addField(document.headingPaths.flatMap(terms), 2.5)
  addField(terms(document.text.slice(0, 12_000)), 1)
  return weights
}

const GENERIC_TITLES = new Set(['readme', 'readme.md', 'index', 'index.md', 'changelog', 'changelog.md'])

function singleDocumentLabel(document: TopicMapCandidate): string | null {
  const trimmed = document.title.trim()
  if (trimmed === '' || GENERIC_TITLES.has(trimmed.toLocaleLowerCase())) return null
  return trimmed
}

interface LabelContext {
  corpusDocFreq: ReadonlyMap<string, number>
  totalDocs: number
  queryTerms: ReadonlySet<string>
}

/** Stable keyword labels: 1-doc branches keep their title; multi-doc branches use distinctive terms. */
function labelFor(documents: readonly TopicMapCandidate[], fallback: string, ctx: LabelContext): string {
  if (documents.length === 1) {
    const title = singleDocumentLabel(documents[0]!)
    if (title !== null) return title
  }
  const scores = new Map<string, number>()
  for (const document of documents) {
    const titleSet = new Set(terms(document.title))
    for (const [word, weight] of documentTermWeights(document)) {
      const df = ctx.corpusDocFreq.get(word) ?? 1
      const idf = 1 + Math.log((ctx.totalDocs + 1) / df)
      const queryScale = ctx.queryTerms.has(word) && !titleSet.has(word) ? 0.6 : 1
      scores.set(word, (scores.get(word) ?? 0) + weight * idf * queryScale)
    }
  }
  const ranked = [...scores]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([word]) => word)
  const chosen: string[] = []
  for (const word of ranked) {
    if (chosen.some((existing) => sharesStem(existing, word))) continue
    chosen.push(word)
    if (chosen.length === 2) break
  }
  return chosen.length === 0 ? fallback : chosen.join(' · ')
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

function makeBranch(documents: readonly TopicMapCandidate[], index: number, ctx: LabelContext): TopicMapBranch {
  const label = labelFor(documents, `Topic ${index + 1}`, ctx)
  if (documents.length <= MAX_TOPIC_BRANCH_DOCUMENTS) {
    return { label, documents: documents.map(toLeaf) }
  }
  const childCount = Math.ceil(documents.length / MAX_TOPIC_BRANCH_DOCUMENTS)
  const children = cluster(documents, childCount).flatMap((group, groupIndex) => {
    const ordered = [...group].sort((a, b) => a.documentId - b.documentId)
    const parts: TopicMapCandidate[][] = []
    for (let i = 0; i < ordered.length; i += MAX_TOPIC_BRANCH_DOCUMENTS) parts.push(ordered.slice(i, i + MAX_TOPIC_BRANCH_DOCUMENTS))
    return parts.map((part, partIndex) => ({
      label: labelFor(part, `${label} ${groupIndex + 1}.${partIndex + 1}`, ctx),
      documents: part.map(toLeaf),
    }))
  })
  return { label, documents: [], branches: children }
}

const cleanQueryText = (value: string): string => value.replace(/\s*·\s*/g, ' ').replace(/\s+/g, ' ').trim()

export function createTopicMapService(options: TopicMapServiceOptions): TopicMapService {
  return {
    async map(request) {
      const topic = request.topic.trim()
      if (topic.length === 0) throw new Error('topic must not be empty')
      const cleanTopic = cleanQueryText(topic)
      const cleanContext = request.context ? cleanQueryText(request.context) : ''
      const embedText = cleanContext ? `${cleanContext}: ${cleanTopic}` : cleanTopic
      const ftsQuery = /\s*·\s*/.test(topic)
        ? topic
            .split(/\s*·\s*/)
            .map((part) => part.trim())
            .filter(Boolean)
            .join(' OR ')
        : topic

      const embedding = await options.embedder.embedQuery(embedText)
      const documents = await options.store.search({
        query: embedText,
        ftsQuery,
        embedding,
        embedModel: options.embedder.model,
        filters: { sources: request.sources, repo: request.repo },
        candidates: TOPIC_MAP_CANDIDATES,
        limit: TOPIC_MAP_LIMIT,
        maxDistance: 1 - TOPIC_MAP_MIN_SIMILARITY,
        strongMaxDistance: 1 - TOPIC_MAP_STRONG_SIMILARITY,
        docMaxDistance: 1 - TOPIC_MAP_DOC_MIN_SIMILARITY,
        ...(cleanContext ? { ftsMaxDistance: 1 - TOPIC_MAP_CONTEXT_MIN_SIMILARITY } : {}),
      })

      const corpusDocFreq = new Map<string, number>()
      for (const document of documents) {
        for (const word of documentTermWeights(document).keys()) {
          corpusDocFreq.set(word, (corpusDocFreq.get(word) ?? 0) + 1)
        }
      }
      const labelContext: LabelContext = {
        corpusDocFreq,
        totalDocs: documents.length,
        queryTerms: new Set(terms(embedText)),
      }

      const branchCount = Math.min(MAX_TOPIC_BRANCHES, Math.max(MIN_TOPIC_BRANCHES, Math.ceil(documents.length / 6)))
      const groups = cluster(documents, branchCount)
      return { topic, branches: groups.map((group, index) => makeBranch(group, index, labelContext)) }
    },
  }
}

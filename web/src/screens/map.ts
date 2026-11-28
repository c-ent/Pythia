import type { GraphResponse } from '../api/graph'
import type { SourceKind } from '../api/search'
import type { TopicMapResponse } from '../api/topicMap'

export type MapView = 'topic' | 'vault'
export type TopicDisplayMode = 'atlas' | 'mindmap' | 'list'

export type TopicMapResult =
  | { key: string; status: 'done'; response: TopicMapResponse }
  | { key: string; status: 'error'; message: string }

export type VaultGraphResult =
  | { key: string; status: 'done'; graph: GraphResponse }
  | { key: string; status: 'error'; message: string }

export interface MapMemory {
  view: MapView
  topic: string
  submittedTopic: string
  trail: string[]
  sources: SourceKind[]
  repo: string
  aiLabels: boolean
  nodeFilter: string
  attempt: number
  result: TopicMapResult | null
  viewOverride: { narrow: boolean; mode: TopicDisplayMode } | null
  vaultAttempt: number
  vaultResult: VaultGraphResult | null
  vaultViewOverride: { narrow: boolean; listView: boolean } | null
}

/**
 * Keeps the active topic map or whole-vault graph in memory while the app is
 * open so opening a document from `/map` and clicking Back returns to the
 * exact same map and branch instead of resetting it.
 */
export const mapMemory: MapMemory = {
  view: 'topic',
  topic: '',
  submittedTopic: '',
  trail: [],
  sources: [],
  repo: '',
  aiLabels: false,
  nodeFilter: '',
  attempt: 0,
  result: null,
  viewOverride: null,
  vaultAttempt: 0,
  vaultResult: null,
  vaultViewOverride: null,
}

export function resetMapMemory(): void {
  mapMemory.view = 'topic'
  mapMemory.topic = ''
  mapMemory.submittedTopic = ''
  mapMemory.trail = []
  mapMemory.sources = []
  mapMemory.repo = ''
  mapMemory.aiLabels = false
  mapMemory.nodeFilter = ''
  mapMemory.attempt = 0
  mapMemory.result = null
  mapMemory.viewOverride = null
  mapMemory.vaultAttempt = 0
  mapMemory.vaultResult = null
  mapMemory.vaultViewOverride = null
}

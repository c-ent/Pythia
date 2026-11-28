import { apiFetch } from './client'
import type { SourceKind, SourceRef } from './search'

// Mirrors POST /api/topic-map (server/src/search/topicMapService.ts).

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
  branches?: TopicMapSubbranch[]
}

export interface TopicMapResponse {
  topic: string
  branches: TopicMapBranch[]
}

export interface TopicMapParams {
  topic: string
  sources?: SourceKind[]
  repo?: string
}

export async function buildTopicMap(params: TopicMapParams, signal?: AbortSignal): Promise<TopicMapResponse> {
  const res = await apiFetch('/api/topic-map', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  })
  return (await res.json()) as TopicMapResponse
}

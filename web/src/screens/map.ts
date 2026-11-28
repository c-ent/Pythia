import { useCallback, useEffect, useMemo, useState } from 'react'
import { getVaultGraph, type GraphResponse } from '../api/graph'
import type { SourceKind } from '../api/search'
import { buildTopicMap, type TopicMapResponse } from '../api/topicMap'
import { isGraphResponse } from '../map/graphModel'
import {
  partitionTopicMap,
  safeTopicBranches,
  topicMapDocuments,
  type VisibleTopicBranch,
} from '../map/topicMapModel'

export type MapView = 'topic' | 'vault'
export type TopicDisplayMode = 'atlas' | 'mindmap' | 'list'

export type TopicMapResult =
  | { key: string; status: 'done'; response: TopicMapResponse }
  | { key: string; status: 'error'; message: string }

export type VaultGraphResult =
  | { key: string; status: 'done'; graph: GraphResponse }
  | { key: string; status: 'error'; message: string }

export type TopicMapLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; response: TopicMapResponse }
  | { status: 'error'; message: string }

export type VaultGraphLoadState =
  | { status: 'loading' }
  | { status: 'done'; graph: GraphResponse }
  | { status: 'error'; message: string }
  | { status: 'offline' }

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

export function drillContext(trail: readonly string[]): string | undefined {
  if (trail.length === 0) return undefined
  if (trail.length <= 2) return trail.join(' · ')
  return `${trail[0]} · ${trail[trail.length - 1]}`
}

export function filterTopicBranches(branches: readonly VisibleTopicBranch[], query: string): VisibleTopicBranch[] {
  const q = query.trim().toLocaleLowerCase()
  if (q === '') return [...branches]
  const filterBranch = (branch: VisibleTopicBranch): VisibleTopicBranch | null => {
    if (branch.label.toLocaleLowerCase().includes(q)) return branch
    const docs = branch.documents.filter(
      (doc) => doc.title.toLocaleLowerCase().includes(q) || doc.path.toLocaleLowerCase().includes(q),
    )
    const subbranches = branch.branches?.map(filterBranch).filter((child): child is VisibleTopicBranch => child !== null)
    if (docs.length === 0 && (subbranches === undefined || subbranches.length === 0)) return null
    return {
      ...branch,
      documents: docs,
      ...(subbranches !== undefined && subbranches.length > 0 ? { branches: subbranches } : {}),
    }
  }
  return branches.map(filterBranch).filter((branch): branch is VisibleTopicBranch => branch !== null)
}

function updateMemory(patch: Partial<MapMemory>): MapMemory {
  Object.assign(mapMemory, patch)
  return { ...mapMemory }
}

/**
 * Self-contained session module for `/map`: owns topic-map state, drill-down
 * trail transitions, node filtering, and abortable fetches without `useEffect`
 * state mirroring.
 */
export function useMapSession({ online, narrow }: { online: boolean; narrow: boolean }) {
  const [session, setSession] = useState<MapMemory>(() => ({ ...mapMemory }))

  const patch = useCallback((update: Partial<MapMemory> | ((prev: MapMemory) => Partial<MapMemory>)) => {
    setSession((prev) => updateMemory(typeof update === 'function' ? update(prev) : update))
  }, [])

  const trimmedTopic = session.submittedTopic.trim()
  const contextText = drillContext(session.trail)
  const activeKey =
    session.attempt > 0 && online && trimmedTopic !== ''
      ? `${session.attempt}:${trimmedTopic}:${contextText ?? ''}:${session.sources.join(',')}:${session.repo.trim()}:${session.aiLabels ? 'ai' : 'local'}`
      : null

  useEffect(() => {
    if (activeKey === null) return
    if (session.result !== null && session.result.status === 'done' && session.result.key === activeKey) return
    const controller = new AbortController()
    buildTopicMap(
      {
        topic: trimmedTopic,
        ...(contextText ? { context: contextText } : {}),
        ...(session.sources.length ? { sources: session.sources } : {}),
        ...(session.repo.trim() ? { repo: session.repo.trim() } : {}),
        ...(session.aiLabels ? { aiLabels: true } : {}),
      },
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) patch({ result: { key: activeKey, status: 'done', response } })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          patch({
            result: {
              key: activeKey,
              status: 'error',
              message: error instanceof Error ? error.message : 'The topic map could not be built.',
            },
          })
        }
      })
    return () => controller.abort()
  }, [activeKey, contextText, patch, session.aiLabels, session.repo, session.result, session.sources, trimmedTopic])

  const state: TopicMapLoadState = useMemo(
    () =>
      activeKey !== null
        ? session.result !== null && session.result.key === activeKey
          ? session.result
          : { status: 'loading' }
        : (session.result ?? { status: 'idle' }),
    [activeKey, session.result],
  )

  const displayMode: TopicDisplayMode =
    session.viewOverride !== null && session.viewOverride.narrow === narrow
      ? session.viewOverride.mode
      : narrow
        ? 'list'
        : 'mindmap'

  const allBranches = useMemo(() => (state.status === 'done' ? safeTopicBranches(state.response.branches) : []), [state])
  const branches = useMemo(() => filterTopicBranches(allBranches, session.nodeFilter), [allBranches, session.nodeFilter])
  const partitioned = useMemo(() => partitionTopicMap(branches), [branches])
  const documents = useMemo(() => topicMapDocuments(branches), [branches])
  const totalDocuments = useMemo(() => topicMapDocuments(allBranches).length, [allBranches])

  return {
    view: session.view,
    topic: session.topic,
    trail: session.trail,
    sources: session.sources,
    repo: session.repo,
    aiLabels: session.aiLabels,
    nodeFilter: session.nodeFilter,
    displayMode,
    state,
    branches,
    partitioned,
    documents,
    totalDocuments,
    setView: (view: MapView) => patch({ view }),
    setTopic: (topic: string) => patch({ topic }),
    setSources: (sources: SourceKind[]) => patch({ sources }),
    setRepo: (repo: string) => patch({ repo }),
    toggleAiLabels: () => patch((prev) => ({ aiLabels: !prev.aiLabels })),
    setNodeFilter: (nodeFilter: string) => patch({ nodeFilter }),
    setDisplayMode: (mode: TopicDisplayMode) => patch({ viewOverride: { narrow, mode } }),
    retry: () => patch((prev) => ({ attempt: prev.attempt + 1 })),
    submit: () => {
      const next = session.topic.trim()
      if (!online || next === '') return
      patch((prev) => ({ trail: [], submittedTopic: next, attempt: prev.attempt + 1 }))
    },
    chooseBranch: (label: string) => {
      const parent = state.status === 'done' ? state.response.topic : trimmedTopic
      patch((prev) => ({
        trail: parent !== '' && parent !== label ? [...prev.trail, parent] : prev.trail,
        topic: label,
        submittedTopic: label,
        attempt: prev.attempt + 1,
      }))
    },
    stepBack: () => {
      const previous = session.trail.at(-1)
      if (previous === undefined) return
      patch((prev) => ({
        trail: prev.trail.slice(0, -1),
        topic: previous,
        submittedTopic: previous,
        attempt: prev.attempt + 1,
      }))
    },
  }
}

/**
 * Session hook for the whole-vault graph panel: owns fetch/abort lifecycle and
 * `mapMemory` persistence.
 */
export function useVaultGraphSession({
  online,
  narrow,
  sources,
  repo,
}: {
  online: boolean
  narrow: boolean
  sources: SourceKind[]
  repo: string
}) {
  const [session, setSession] = useState<MapMemory>(() => ({ ...mapMemory }))

  const patch = useCallback((update: Partial<MapMemory> | ((prev: MapMemory) => Partial<MapMemory>)) => {
    setSession((prev) => updateMemory(typeof update === 'function' ? update(prev) : update))
  }, [])

  const listView =
    session.vaultViewOverride !== null && session.vaultViewOverride.narrow === narrow
      ? session.vaultViewOverride.listView
      : narrow
  const requestKey = `${session.vaultAttempt}:${sources.join(',')}:${repo.trim()}`

  useEffect(() => {
    if (!online) return
    if (session.vaultResult !== null && session.vaultResult.status === 'done' && session.vaultResult.key === requestKey) return
    const controller = new AbortController()
    getVaultGraph(
      { ...(sources.length ? { sources } : {}), ...(repo.trim() ? { repo: repo.trim() } : {}) },
      controller.signal,
    )
      .then((graph) => {
        if (!controller.signal.aborted) patch({ vaultResult: { key: requestKey, status: 'done', graph } })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          patch({
            vaultResult: {
              key: requestKey,
              status: 'error',
              message: error instanceof Error ? error.message : 'The whole-vault graph could not be loaded.',
            },
          })
        }
      })
    return () => controller.abort()
  }, [online, patch, repo, requestKey, session.vaultResult, sources])

  const state: VaultGraphLoadState = !online
    ? { status: 'offline' }
    : session.vaultResult !== null && session.vaultResult.key === requestKey
      ? session.vaultResult
      : { status: 'loading' }
  const graph = state.status === 'done' && isGraphResponse(state.graph) ? state.graph : null

  return {
    listView,
    state,
    graph,
    toggleListView: () => patch({ vaultViewOverride: { narrow, listView: !listView } }),
    retry: () => patch((prev) => ({ vaultAttempt: prev.vaultAttempt + 1 })),
  }
}

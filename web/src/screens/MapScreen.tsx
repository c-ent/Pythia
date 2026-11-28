import { ArrowLeft, ChevronDown, ChevronRight, Compass, Copy, LoaderCircle, Map, RotateCw, Sparkles, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { buildTopicMap, type TopicMapResponse } from '../api/topicMap'
import type { SourceKind } from '../api/search'
import { useClipboard } from '../hooks/useClipboard'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { partitionTopicMap, safeTopicBranches, topicMapDocuments, topicMapOutline, type PartitionedTopicMap, type VisibleTopicBranch } from '../map/topicMapModel'
import { NODE_TONES, TONE_LABELS, TONE_SWATCH } from '../map/graphModel'
import { documentPath, followLink } from '../router'
import { SOURCE_LABELS } from '../search/format'
import { SourceChips } from '../search/SourceChips'
import { VaultGraphPanel } from '../map/VaultGraphPanel'
import { mapMemory, type MapView, type TopicDisplayMode, type TopicMapResult } from './map'

const TopicAtlas = lazy(() => import('../map/TopicAtlas').then((module) => ({ default: module.TopicAtlas })))
const TopicMindmap = lazy(() => import('../map/TopicMindmap').then((module) => ({ default: module.TopicMindmap })))

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; response: TopicMapResponse } | { status: 'error'; message: string }

const BUTTON = 'inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:opacity-50'

function drillContext(trail: readonly string[]): string | undefined {
  if (trail.length === 0) return undefined
  if (trail.length <= 2) return trail.join(' · ')
  return `${trail[0]} · ${trail[trail.length - 1]}`
}

function filterTopicBranches(branches: readonly VisibleTopicBranch[], query: string): VisibleTopicBranch[] {
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

export function MapScreen() {
  const online = useOnline()
  const narrow = useMediaQuery('(max-width: 639px)')
  const [topic, setTopic] = useState(() => mapMemory.topic)
  const [submittedTopic, setSubmittedTopic] = useState(() => mapMemory.submittedTopic)
  const [trail, setTrail] = useState<string[]>(() => mapMemory.trail)
  const [sources, setSources] = useState<SourceKind[]>(() => mapMemory.sources)
  const [repo, setRepo] = useState(() => mapMemory.repo)
  const [aiLabels, setAiLabels] = useState(() => mapMemory.aiLabels)
  const [nodeFilter, setNodeFilter] = useState(() => mapMemory.nodeFilter)
  const [result, setResult] = useState<TopicMapResult | null>(() => mapMemory.result)
  const [viewOverride, setViewOverride] = useState<{ narrow: boolean; mode: TopicDisplayMode } | null>(() => mapMemory.viewOverride)
  const displayMode: TopicDisplayMode = viewOverride !== null && viewOverride.narrow === narrow ? viewOverride.mode : (narrow ? 'list' : 'mindmap')
  const [attempt, setAttempt] = useState(() => mapMemory.attempt)
  const [copied, copy] = useClipboard()
  const [view, setView] = useState<MapView>(() => mapMemory.view)

  const trimmedTopic = submittedTopic.trim()
  const contextText = drillContext(trail)
  const activeKey = attempt > 0 && online && trimmedTopic !== ''
    ? `${attempt}:${trimmedTopic}:${contextText ?? ''}:${sources.join(',')}:${repo.trim()}:${aiLabels ? 'ai' : 'local'}`
    : null

  useEffect(() => {
    mapMemory.view = view
    mapMemory.topic = topic
    mapMemory.submittedTopic = submittedTopic
    mapMemory.trail = trail
    mapMemory.sources = sources
    mapMemory.repo = repo
    mapMemory.aiLabels = aiLabels
    mapMemory.nodeFilter = nodeFilter
    mapMemory.attempt = attempt
    mapMemory.result = result
    mapMemory.viewOverride = viewOverride
  }, [aiLabels, attempt, nodeFilter, repo, result, sources, submittedTopic, topic, trail, view, viewOverride])

  useEffect(() => {
    if (activeKey === null) return
    if (result !== null && result.status === 'done' && result.key === activeKey) return
    const controller = new AbortController()
    buildTopicMap(
      {
        topic: trimmedTopic,
        ...(contextText ? { context: contextText } : {}),
        ...(sources.length ? { sources } : {}),
        ...(repo.trim() ? { repo: repo.trim() } : {}),
        ...(aiLabels ? { aiLabels: true } : {}),
      },
      controller.signal,
    )
      .then((response) => { if (!controller.signal.aborted) setResult({ key: activeKey, status: 'done', response }) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key: activeKey, status: 'error', message: error instanceof Error ? error.message : 'The topic map could not be built.' })
      })
    return () => controller.abort()
  }, [activeKey, aiLabels, contextText, repo, result, sources, trimmedTopic])

  const state: LoadState = useMemo(
    () => activeKey !== null
      ? (result !== null && result.key === activeKey ? result : { status: 'loading' })
      : (result ?? { status: 'idle' }),
    [activeKey, result],
  )
  const allBranches = useMemo(() => state.status === 'done' ? safeTopicBranches(state.response.branches) : [], [state])
  const branches = useMemo(() => filterTopicBranches(allBranches, nodeFilter), [allBranches, nodeFilter])
  const partitioned = useMemo(() => partitionTopicMap(branches), [branches])
  const documents = useMemo(() => topicMapDocuments(branches), [branches])
  const totalDocuments = useMemo(() => topicMapDocuments(allBranches).length, [allBranches])
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const next = topic.trim()
    if (!online || next === '') return
    setTrail([])
    setSubmittedTopic(next)
    setAttempt((n) => n + 1)
  }
  const copyOutline = async (): Promise<void> => {
    if (state.status === 'done') await copy(topicMapOutline(state.response))
  }
  const chooseBranch = (label: string): void => {
    const parent = state.status === 'done' ? state.response.topic : trimmedTopic
    if (parent !== '' && parent !== label) setTrail((prev) => [...prev, parent])
    setTopic(label)
    setSubmittedTopic(label)
    setAttempt((n) => n + 1)
  }
  const stepBack = (): void => {
    const previous = trail.at(-1)
    if (previous === undefined) return
    setTrail((prev) => prev.slice(0, -1))
    setTopic(previous)
    setSubmittedTopic(previous)
    setAttempt((n) => n + 1)
  }

  return (
    <section aria-labelledby="map-title" className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-accent-ink"><Map aria-hidden="true" className="size-4" /> Knowledge map</div>
          <h1 id="map-title" className="mt-1.5 text-2xl font-semibold tracking-tight md:text-3xl">Explore your knowledge</h1>
          <p className="mt-1 max-w-prose text-sm text-muted">Explore a topic or see how notes, tags and repositories connect across your index.</p>
        </div>
        <div role="group" aria-label="Map view" className="inline-flex rounded-control bg-raised p-1">
          <button type="button" aria-pressed={view === 'topic'} onClick={() => setView('topic')} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-4 text-sm ${view === 'topic' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>Topic map</button>
          <button type="button" aria-pressed={view === 'vault'} onClick={() => setView('vault')} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-4 text-sm ${view === 'vault' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>Whole vault</button>
        </div>
      </header>
      {view === 'vault' ? <>
        <div className="rounded-card border border-line bg-surface p-4 md:px-5 md:py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Filter the graph</p>
              <div className="mt-2"><SourceChips value={sources} onChange={setSources} /></div>
            </div>
            <div className="w-full min-w-0 lg:w-64 lg:shrink-0">
              <label htmlFor="repo-filter" className="block text-sm font-medium">Repository <span className="font-normal text-muted">(optional)</span></label>
              <input id="repo-filter" value={repo} onChange={(event) => setRepo(event.target.value)} maxLength={200} placeholder="Filter to a repo name" className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted" />
            </div>
          </div>
        </div>
        <VaultGraphPanel sources={sources} repo={repo} />
      </> : <>
      <form onSubmit={submit} className="rounded-card border border-line bg-surface p-4 md:px-5 md:py-4">
        <div className="flex flex-col gap-4">
          <div className="min-w-0">
            <label htmlFor="topic" className="block text-sm font-medium">Topic</label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input id="topic" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={1000} placeholder="What do you want to explore?" className="min-h-11 min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent-ink" />
              <button type="submit" disabled={!online || !topic.trim() || state.status === 'loading'} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-strong px-5 text-sm font-medium text-on-strong disabled:opacity-50">
                {state.status === 'loading' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null} Build map
              </button>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1"><SourceChips value={sources} onChange={setSources} /></div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-full min-w-0 sm:w-52 sm:shrink-0">
                <label htmlFor="repo-filter" className="block text-sm font-medium">Repository <span className="font-normal text-muted">(optional)</span></label>
                <input id="repo-filter" value={repo} onChange={(event) => setRepo(event.target.value)} maxLength={200} placeholder="Filter to a repo name" className="mt-1.5 min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted" />
              </div>
              <button
                type="button"
                aria-pressed={aiLabels}
                disabled={!online}
                onClick={() => setAiLabels((prev) => !prev)}
                className={`inline-flex min-h-11 items-center gap-2 rounded-control border px-3.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                  aiLabels ? 'border-strong bg-strong text-on-strong' : 'border-line bg-canvas text-ink hover:bg-raised'
                }`}
              >
                <Sparkles aria-hidden="true" className="size-4" />
                AI labels
              </button>
            </div>
          </div>
        </div>
        {!online ? <p className="mt-3 text-sm text-warning">Topic maps need the server. Reconnect to build a map.</p> : null}
      </form>

      {state.status === 'idle' ? <div className="rounded-card border border-dashed border-line bg-surface px-5 py-10 text-center"><Map aria-hidden="true" className="mx-auto size-8 text-muted" /><p className="mt-3 font-medium">Your map will appear here</p><p className="mt-1 text-sm text-muted">Enter a topic to group related documents.</p></div> : null}
      {state.status === 'loading' ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Building your map…</p> : null}
      {state.status === 'error' ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"><TriangleAlert aria-hidden="true" className="size-4" /><span className="flex-1">{state.message}</span><button type="button" className={BUTTON} onClick={() => setAttempt((n) => n + 1)}><RotateCw aria-hidden="true" className="size-4" />Retry</button></div> : null}
      {state.status === 'done' ? (
        <section aria-label={`Map for ${state.response.topic}`} className="rounded-card border border-line bg-surface p-4 md:p-5">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Topic map</p>
              <h2 className="mt-1 text-xl font-semibold">{state.response.topic}</h2>
              {trail.length > 0 ? <p className="mt-0.5 text-xs text-muted">Inside {trail.join(' › ')}</p> : null}
              <p className="mt-1 text-sm text-muted">
                {documents.length} {documents.length === 1 ? 'document' : 'documents'}
                {partitioned.branches.length > 0
                  ? ` · ${partitioned.branches.length} ${partitioned.branches.length === 1 ? 'branch' : 'branches'}`
                  : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {trail.length > 0 ? <button type="button" onClick={stepBack} className={BUTTON}><ArrowLeft aria-hidden="true" className="size-4" />Back to {trail.at(-1)}</button> : null}
              <button type="button" onClick={() => void copyOutline()} className={BUTTON}><Copy aria-hidden="true" className="size-4" />{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy as Markdown'}</button>
              {totalDocuments > 0 ? (
                <div role="group" aria-label="Topic display" className="inline-flex rounded-control bg-raised p-1">
                  <button type="button" aria-pressed={displayMode === 'mindmap'} onClick={() => setViewOverride({ narrow, mode: 'mindmap' })} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-3.5 text-sm ${displayMode === 'mindmap' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>2D</button>
                  <button type="button" aria-pressed={displayMode === 'atlas'} onClick={() => setViewOverride({ narrow, mode: 'atlas' })} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-3.5 text-sm ${displayMode === 'atlas' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>3D</button>
                  <button type="button" aria-pressed={displayMode === 'list'} onClick={() => setViewOverride({ narrow, mode: 'list' })} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-3.5 text-sm ${displayMode === 'list' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>List</button>
                </div>
              ) : null}
            </div>
          </header>
          {totalDocuments > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                type="search"
                aria-label="Filter nodes"
                value={nodeFilter}
                onChange={(event) => setNodeFilter(event.target.value)}
                maxLength={120}
                placeholder="Filter nodes by title or path"
                className="min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted sm:max-w-xs"
              />
              {nodeFilter.trim() !== '' ? (
                <button type="button" onClick={() => setNodeFilter('')} className="min-h-11 rounded-control px-3 text-sm text-muted hover:bg-raised hover:text-ink">
                  Clear filter
                </button>
              ) : null}
            </div>
          ) : null}
          {documents.length === 0 ? <p className="py-10 text-center text-sm text-muted">{totalDocuments > 0 ? 'No nodes match this filter.' : 'No matching map documents were found. Try another topic or filter.'}</p> : displayMode === 'list' ? <TopicList partitioned={partitioned} onBranch={chooseBranch} /> : <>
            {displayMode === 'mindmap' ? (
              <Suspense fallback={<p role="status" className="flex h-104 items-center justify-center gap-2 text-sm text-muted md:h-136"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Drawing the mindmap…</p>}>
                <TopicMindmap topic={state.response.topic} branches={branches} partitioned={partitioned} onBranch={chooseBranch} />
              </Suspense>
            ) : (
              <>
                <Suspense fallback={<p role="status" className="flex h-104 items-center justify-center gap-2 text-sm text-muted md:h-136"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Drawing the atlas…</p>}>
                  <TopicAtlas topic={state.response.topic} branches={branches} onBranch={chooseBranch} />
                </Suspense>
                <ul aria-label="Topic map colours" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  {NODE_TONES.filter((tone) => documents.some((doc) => doc.source.kind === tone)).map((tone) => (
                    <li key={tone} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-2.5 rounded-full ${TONE_SWATCH[tone]}`} />{TONE_LABELS[tone]}</li>
                  ))}
                </ul>
              </>
            )}
            <details className="mt-3 rounded-control border border-line bg-canvas px-3.5 py-1.5">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between text-sm font-medium text-ink">
                <span>Where these branches come from</span>
                <span className="text-xs font-normal text-muted">{documents.length} {documents.length === 1 ? 'source' : 'sources'}</span>
              </summary>
              <div className="border-t border-line pt-2 pb-2">
                <BranchSources partitioned={partitioned} />
              </div>
            </details>
          </>}
        </section>
      ) : null}
      </>}
    </section>
  )
}

function TopicList({ partitioned, onBranch }: { partitioned: PartitionedTopicMap; onBranch: (label: string) => void }) {
  return (
    <ul aria-label="Topic map outline" className="mt-4 space-y-3">
      {partitioned.branches.map((branch) => (
        <li key={branch.label} className="rounded-control bg-canvas p-3">
          <BranchList branch={branch} depth={0} onBranch={onBranch} />
        </li>
      ))}
      {partitioned.directDocuments.length > 0 ? (
        <li className="rounded-control bg-canvas p-2">
          {partitioned.directDocuments.map((document) => (
            <DocumentLink key={document.documentId} document={document} />
          ))}
        </li>
      ) : null}
    </ul>
  )
}

function BranchList({ branch, depth, onBranch }: { branch: VisibleTopicBranch; depth: number; onBranch: (label: string) => void }) {
  const [expanded, setExpanded] = useState(true)
  const count = branch.branches?.length ?? branch.documents.length
  return <div className={depth ? 'ml-4 mt-3 border-l border-line pl-3' : ''}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 text-left font-medium text-ink hover:bg-raised"
      >
        {expanded ? <ChevronDown aria-hidden="true" className="size-4 text-muted" /> : <ChevronRight aria-hidden="true" className="size-4 text-muted" />}
        <span>{branch.label}</span>
        <span className="ml-1 text-xs font-normal text-muted">{count}</span>
      </button>
      <button
        type="button"
        onClick={() => onBranch(branch.label)}
        aria-label={`Explore ${branch.label}`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-xs font-medium text-accent-ink hover:bg-raised"
      >
        <Compass aria-hidden="true" className="size-3.5" />
        Explore
      </button>
    </div>
    {expanded ? <>
      {branch.branches?.map((child) => <BranchList key={child.label} branch={child} depth={depth + 1} onBranch={onBranch} />)}
      {branch.documents.map((document) => <DocumentLink key={document.documentId} document={document} />)}
    </> : null}
  </div>
}

function BranchSourceRows({ docs }: { docs: VisibleTopicBranch['documents'] }) {
  return (
    <ul className="mt-1 space-y-1">
      {docs.map((doc) => {
        const path = documentPath(doc.documentId)
        return (
          <li key={doc.documentId}>
            <a href={path} onClick={(event) => followLink(event, path)} className="flex min-h-11 items-center justify-between gap-3 rounded-control px-2 text-sm text-ink hover:bg-raised">
              <span className="min-w-0 truncate">
                <span className="font-medium text-accent-ink">{doc.title}</span>
                <span className="ml-2 font-mono text-xs text-muted">{doc.path}</span>
              </span>
              <span className="shrink-0 text-xs text-muted">{SOURCE_LABELS[doc.source.kind]}</span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}

function BranchSources({ partitioned }: { partitioned: PartitionedTopicMap }) {
  const flatten = (branch: VisibleTopicBranch): VisibleTopicBranch['documents'] => [
    ...branch.documents,
    ...(branch.branches?.flatMap(flatten) ?? []),
  ]
  return (
    <ul aria-label="Branch sources" className="space-y-3">
      {partitioned.branches.map((branch) => {
        const docs = flatten(branch)
        return (
          <li key={branch.label}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{branch.label}</p>
            <BranchSourceRows docs={docs} />
          </li>
        )
      })}
      {partitioned.directDocuments.length > 0 ? (
        <li>
          {partitioned.branches.length > 0 ? (
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Direct matches</p>
          ) : null}
          <BranchSourceRows docs={partitioned.directDocuments} />
        </li>
      ) : null}
    </ul>
  )
}

function DocumentLink({ document }: { document: { documentId: number; title: string; path: string; source: { kind: SourceKind }; allowLlm: boolean } }) {
  const path = documentPath(document.documentId)
  return <a href={path} onClick={(event) => followLink(event, path)} className="flex min-h-11 items-center justify-between gap-3 rounded-control px-2 text-sm hover:bg-raised"><span className="min-w-0 truncate">{document.title}</span><span className="shrink-0 text-xs text-muted">{SOURCE_LABELS[document.source.kind]}{document.allowLlm ? '' : ' · Local only'}</span></a>
}

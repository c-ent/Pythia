import { Copy, LoaderCircle, Map, RotateCw, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { buildTopicMap, type TopicMapResponse } from '../api/topicMap'
import type { SourceKind } from '../api/search'
import { useClipboard } from '../hooks/useClipboard'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { safeTopicBranches, topicMapDocuments, topicMapOutline, type VisibleTopicBranch } from '../map/topicMapModel'
import { NODE_TONES, TONE_LABELS, TONE_SWATCH } from '../map/graphModel'
import { documentPath, followLink } from '../router'
import { SOURCE_LABELS } from '../search/format'
import { SourceChips } from '../search/SourceChips'
import { VaultGraphPanel } from '../map/VaultGraphPanel'

const TopicAtlas = lazy(() => import('../map/TopicAtlas').then((module) => ({ default: module.TopicAtlas })))

type LoadState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; response: TopicMapResponse } | { status: 'error'; message: string }

const BUTTON = 'inline-flex min-h-11 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:opacity-50'
type MapView = 'topic' | 'vault'

export function MapScreen() {
  const online = useOnline()
  const narrow = useMediaQuery('(max-width: 639px)')
  const [topic, setTopic] = useState('')
  const [sources, setSources] = useState<SourceKind[]>([])
  const [repo, setRepo] = useState('')
  const [result, setResult] = useState<{ key: string; status: 'done'; response: TopicMapResponse } | { key: string; status: 'error'; message: string } | null>(null)
  const [viewOverride, setViewOverride] = useState<{ narrow: boolean; listView: boolean } | null>(null)
  const listView = viewOverride !== null && viewOverride.narrow === narrow ? viewOverride.listView : narrow
  const [attempt, setAttempt] = useState(0)
  const [copied, copy] = useClipboard()
  const [view, setView] = useState<MapView>('topic')

  const trimmedTopic = topic.trim()
  const activeKey = attempt > 0 && online && trimmedTopic !== ''
    ? `${attempt}:${trimmedTopic}:${sources.join(',')}:${repo.trim()}`
    : null

  useEffect(() => {
    if (activeKey === null) return
    const controller = new AbortController()
    buildTopicMap({ topic: trimmedTopic, ...(sources.length ? { sources } : {}), ...(repo.trim() ? { repo: repo.trim() } : {}) }, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setResult({ key: activeKey, status: 'done', response }) })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key: activeKey, status: 'error', message: error instanceof Error ? error.message : 'The topic map could not be built.' })
      })
    return () => controller.abort()
  }, [activeKey, repo, sources, trimmedTopic])

  const state: LoadState = useMemo(
    () => activeKey !== null
      ? (result !== null && result.key === activeKey ? result : { status: 'loading' })
      : (result ?? { status: 'idle' }),
    [activeKey, result],
  )
  const branches = useMemo(() => state.status === 'done' ? safeTopicBranches(state.response.branches) : [], [state])
  const documents = useMemo(() => topicMapDocuments(branches), [branches])
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!online || trimmedTopic === '') return
    setAttempt((n) => n + 1)
  }
  const copyOutline = async (): Promise<void> => {
    if (state.status === 'done') await copy(topicMapOutline(state.response))
  }
  const chooseBranch = (label: string): void => {
    setTopic(label)
    setAttempt((n) => n + 1)
  }

  return (
    <section aria-labelledby="map-title" className="space-y-6">
      <header>
        <div className="flex items-center gap-2 text-sm font-medium text-accent-ink"><Map aria-hidden="true" className="size-4" /> Knowledge map</div>
        <h1 id="map-title" className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">Explore your knowledge</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">Explore a topic or see how notes, tags and repositories connect across your index.</p>
      </header>
      <div role="group" aria-label="Map view" className="inline-flex rounded-control bg-raised p-1">
        <button type="button" aria-pressed={view === 'topic'} onClick={() => setView('topic')} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-4 text-sm ${view === 'topic' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>Topic map</button>
        <button type="button" aria-pressed={view === 'vault'} onClick={() => setView('vault')} className={`inline-flex min-h-11 items-center rounded-[0.5rem] px-4 text-sm ${view === 'vault' ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'}`}>Whole vault</button>
      </div>
      {view === 'vault' ? <>
        <div className="rounded-card border border-line bg-surface p-4 md:p-5">
          <div><p className="text-sm font-medium">Filter the graph</p><p className="mt-1 text-xs text-muted">Choose sources and optionally narrow the view to one repository.</p></div>
          <div className="mt-3"><SourceChips value={sources} onChange={setSources} /></div>
          <label htmlFor="repo-filter" className="mt-4 block text-sm font-medium">Repository <span className="font-normal text-muted">(optional)</span></label>
          <input id="repo-filter" value={repo} onChange={(event) => setRepo(event.target.value)} maxLength={200} placeholder="Filter to a repo name" className="mt-2 min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted sm:max-w-sm" />
        </div>
        <VaultGraphPanel sources={sources} repo={repo} />
      </> : <>
      <form onSubmit={submit} className="rounded-card border border-line bg-surface p-4 md:p-5">
        <label htmlFor="topic" className="block text-sm font-medium">Topic</label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input id="topic" value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={1000} placeholder="What do you want to explore?" className="min-h-11 min-w-0 flex-1 rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent-ink" />
          <button type="submit" disabled={!online || !topic.trim() || state.status === 'loading'} className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-control bg-strong px-5 text-sm font-medium text-on-strong disabled:opacity-50">
            {state.status === 'loading' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : null} Build map
          </button>
        </div>
        <div className="mt-4"><SourceChips value={sources} onChange={setSources} /></div>
        <label htmlFor="repo-filter" className="mt-4 block text-sm font-medium">Repository <span className="font-normal text-muted">(optional)</span></label>
        <input id="repo-filter" value={repo} onChange={(event) => setRepo(event.target.value)} maxLength={200} placeholder="Filter to a repo name" className="mt-2 min-h-11 w-full rounded-control border border-line bg-canvas px-3 text-base text-ink placeholder:text-muted sm:max-w-sm" />
        {!online ? <p className="mt-3 text-sm text-warning">Topic maps need the server. Reconnect to build a map.</p> : null}
      </form>

      {state.status === 'idle' ? <div className="rounded-card border border-dashed border-line bg-surface px-5 py-10 text-center"><Map aria-hidden="true" className="mx-auto size-8 text-muted" /><p className="mt-3 font-medium">Your map will appear here</p><p className="mt-1 text-sm text-muted">Enter a topic to group related documents.</p></div> : null}
      {state.status === 'loading' ? <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Building your map…</p> : null}
      {state.status === 'error' ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"><TriangleAlert aria-hidden="true" className="size-4" /><span className="flex-1">{state.message}</span><button type="button" className={BUTTON} onClick={() => setAttempt((n) => n + 1)}><RotateCw aria-hidden="true" className="size-4" />Retry</button></div> : null}
      {state.status === 'done' ? (
        <section aria-label={`Map for ${state.response.topic}`} className="rounded-card border border-line bg-surface p-4 md:p-5">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
            <div><p className="text-xs font-medium uppercase tracking-wide text-muted">Topic map</p><h2 className="mt-1 text-xl font-semibold">{state.response.topic}</h2><p className="mt-1 text-sm text-muted">{documents.length} documents · {branches.length} branches</p></div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copyOutline()} className={BUTTON}><Copy aria-hidden="true" className="size-4" />{copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy as Markdown'}</button>
              {documents.length > 0 ? <button type="button" aria-pressed={listView} onClick={() => setViewOverride({ narrow, listView: !listView })} className={BUTTON}>{listView ? 'Show map' : 'Show list'}</button> : null}
            </div>
          </header>
          {documents.length === 0 ? <p className="py-10 text-center text-sm text-muted">No matching map documents were found. Try another topic or filter.</p> : listView ? <TopicList branches={branches} onBranch={chooseBranch} /> : <>
            <Suspense fallback={<p role="status" className="flex h-104 items-center justify-center gap-2 text-sm text-muted md:h-136"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Drawing the atlas…</p>}>
              <TopicAtlas topic={state.response.topic} branches={branches} onBranch={chooseBranch} />
            </Suspense>
            <ul aria-label="Topic map colours" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              {NODE_TONES.filter((tone) => documents.some((doc) => doc.source.kind === tone)).map((tone) => (
                <li key={tone} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-2.5 rounded-full ${TONE_SWATCH[tone]}`} />{TONE_LABELS[tone]}</li>
              ))}
            </ul>
          </>}
        </section>
      ) : null}
      </>}
    </section>
  )
}

function TopicList({ branches, onBranch }: { branches: VisibleTopicBranch[]; onBranch: (label: string) => void }) {
  return <ul aria-label="Topic map outline" className="mt-4 space-y-3">{branches.map((branch) => <li key={branch.label} className="rounded-control bg-canvas p-3"><BranchList branch={branch} depth={0} onBranch={onBranch} /></li>)}</ul>
}

function BranchList({ branch, depth, onBranch }: { branch: VisibleTopicBranch; depth: number; onBranch: (label: string) => void }) {
  return <div className={depth ? 'ml-4 mt-3 border-l border-line pl-3' : ''}>
    <button type="button" onClick={() => onBranch(branch.label)} className="min-h-11 rounded-control px-2 text-left font-medium text-accent-ink hover:bg-raised">{branch.label}<span className="ml-2 text-xs font-normal text-muted">{branch.branches?.length ?? branch.documents.length}</span></button>
    {branch.branches?.map((child) => <BranchList key={child.label} branch={child} depth={depth + 1} onBranch={onBranch} />)}
    {branch.documents.map((document) => <DocumentLink key={document.documentId} document={document} />)}
  </div>
}

function DocumentLink({ document }: { document: { documentId: number; title: string; path: string; source: { kind: SourceKind }; allowLlm: boolean } }) {
  const path = documentPath(document.documentId)
  return <a href={path} onClick={(event) => followLink(event, path)} className="flex min-h-11 items-center justify-between gap-3 rounded-control px-2 text-sm hover:bg-raised"><span className="min-w-0 truncate">{document.title}</span><span className="shrink-0 text-xs text-muted">{SOURCE_LABELS[document.source.kind]}{document.allowLlm ? '' : ' · Local only'}</span></a>
}

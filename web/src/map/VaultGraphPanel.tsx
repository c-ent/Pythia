import { LoaderCircle, Network, RotateCw, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { SourceKind } from '../api/search'
import { getVaultGraph, type GraphNode, type GraphResponse } from '../api/graph'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { documentPath, followLink, repoPath } from '../router'
import { SOURCE_LABELS } from '../search/format'
import { isGraphResponse, nodeTone, TONE_LABELS, TONE_SWATCH, tonesIn } from './graphModel'

const GraphCanvas = lazy(() => import('./GraphCanvas').then((module) => ({ default: module.GraphCanvas })))
const NARROW_QUERY = '(max-width: 639px)'

type State = { status: 'loading' } | { status: 'done'; graph: GraphResponse } | { status: 'error'; message: string } | { status: 'offline' }

export function VaultGraphPanel({ sources, repo }: { sources: SourceKind[]; repo: string }) {
  const online = useOnline()
  const narrow = useMediaQuery(NARROW_QUERY)
  const [viewOverride, setViewOverride] = useState<{ narrow: boolean; listView: boolean } | null>(null)
  const listView = viewOverride !== null && viewOverride.narrow === narrow ? viewOverride.listView : narrow
  const [attempt, setAttempt] = useState(0)
  const requestKey = `${attempt}:${sources.join(',')}:${repo.trim()}`
  const [result, setResult] = useState<{ key: string; status: 'done'; graph: GraphResponse } | { key: string; status: 'error'; message: string } | null>(null)
  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getVaultGraph({ ...(sources.length ? { sources } : {}), ...(repo.trim() ? { repo: repo.trim() } : {}) }, controller.signal)
      .then((graph) => { if (!controller.signal.aborted) setResult({ key: requestKey, status: 'done', graph }) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setResult({ key: requestKey, status: 'error', message: error instanceof Error ? error.message : 'The whole-vault graph could not be loaded.' }) })
    return () => controller.abort()
  }, [online, repo, requestKey, sources])

  const state: State = !online ? { status: 'offline' } : result !== null && result.key === requestKey ? result : { status: 'loading' }
  const graph = state.status === 'done' && isGraphResponse(state.graph) ? state.graph : null
  const tones = useMemo(() => graph ? tonesIn(graph) : [], [graph])
  return <section aria-label="Whole-vault graph" className="mt-5 rounded-card border border-line bg-surface p-4 md:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      <div><p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted"><Network aria-hidden="true" className="size-4" />Whole-vault graph</p><p className="mt-1 text-sm text-muted">{graph ? `${graph.nodes.length} items · ${graph.edges.length} connections` : 'Notes, tags and repositories connected across your index.'}</p></div>
      {graph && graph.nodes.length > 0 ? <button type="button" aria-pressed={listView} onClick={() => setViewOverride({ narrow, listView: !listView })} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 text-sm text-ink hover:bg-raised">{listView ? 'Show graph' : 'Show list'}</button> : null}
    </header>
    {state.status === 'loading' ? <p role="status" className="flex h-44 items-center justify-center gap-2 text-sm text-muted"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Loading whole-vault graph…</p> : null}
    {state.status === 'offline' ? <p className="py-8 text-center text-sm text-warning">The whole-vault graph needs the server.</p> : null}
    {state.status === 'error' ? <div role="alert" className="flex flex-wrap items-center gap-3 py-5 text-sm text-danger"><TriangleAlert aria-hidden="true" className="size-4" /><span className="flex-1">{state.message}</span><button type="button" onClick={() => setAttempt((n) => n + 1)} className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line px-4 text-ink"><RotateCw aria-hidden="true" className="size-4" />Retry</button></div> : null}
    {graph ? <>
      {graph.nodes.length === 0 ? <p className="py-10 text-center text-sm text-muted">No map documents match these filters.</p> : listView ? <VaultGraphList nodes={graph.nodes} /> : <Suspense fallback={<p role="status" className="flex h-[62dvh] min-h-104 items-center justify-center gap-2 text-sm text-muted md:h-[68dvh]"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Drawing the graph…</p>}><GraphCanvas graph={graph} title="Vault Atlas" heightClassName="h-[62dvh] min-h-104 md:h-[68dvh]" /></Suspense>}
      {graph.nodes.length ? <ul aria-label="Graph colours" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">{tones.map((tone) => <li key={tone} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className={`size-2.5 rounded-full ${TONE_SWATCH[tone]}`} />{TONE_LABELS[tone]}</li>)}</ul> : null}
      {graph.truncated ? <p className="mt-2 text-xs text-muted">The graph is showing the best-connected items; more are available.</p> : null}
    </> : null}
  </section>
}

function VaultGraphList({ nodes }: { nodes: GraphNode[] }) {
  const documents = nodes.filter((node) => node.type === 'document')
  const other = nodes.filter((node) => node.type !== 'document')
  return <div className="mt-3 space-y-4" role="list" aria-label="Whole-vault graph items">
    {documents.length ? <GraphNodeGroup title="Documents" nodes={documents} /> : null}
    {other.length ? <GraphNodeGroup title="Tags and repositories" nodes={other} /> : null}
  </div>
}

function GraphNodeGroup({ title, nodes }: { title: string; nodes: GraphNode[] }) {
  return <section><h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</h3><ul className="divide-y divide-line">{nodes.map((node) => {
    const tone = nodeTone(node)
    const path =
      node.type === 'document' && node.documentId !== null
        ? documentPath(node.documentId)
        : node.type === 'repo'
          ? repoPath(node.label)
          : null
    const label = node.type === 'tag' ? `#${node.label}` : node.label
    return <li key={node.id} className="flex min-h-11 items-center gap-3 py-1.5"><span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${TONE_SWATCH[tone]}`} /><div className="min-w-0 flex-1">{path ? <a href={path} onClick={(event) => followLink(event, path)} className="inline-flex min-h-11 items-center rounded-control px-1 text-sm font-medium text-ink hover:bg-raised">{label}</a> : <span className="text-sm text-ink">{label}</span>}<p className="text-xs text-muted">{node.type === 'document' ? (node.sourceLabel ?? (node.source ? SOURCE_LABELS[node.source.kind] : 'Document')) : TONE_LABELS[tone]} · {node.links} {node.links === 1 ? 'connection' : 'connections'}</p></div></li>
  })}</ul></section>
}

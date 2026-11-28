import { LoaderCircle, Lock, Network, RotateCw } from 'lucide-react'
import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { ApiError } from '../api/client'
import { getLocalGraph, type LocalGraphResponse } from '../api/graph'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { offlineLocalGraph } from '../offline/offlineMap'
import { documentPath, followLink, repoPath } from '../router'
import { connectedCount, isLocalGraphResponse, listGroups, TONE_LABELS, TONE_SWATCH, tonesIn, type ListEntry } from './graphModel'

// Cytoscape is large; it loads only when the graph view is shown, in its own chunk.
const GraphCanvas = lazy(() => import('./GraphCanvas').then((module) => ({ default: module.GraphCanvas })))

/** From this width the graph is the default view; below it (iPhone, iPad split view) the list is (R20). */
export const GRAPH_DEFAULT_QUERY = '(min-width: 640px)'

type View = 'graph' | 'list'

type LoadState =
  | { status: 'loading' }
  | { status: 'done'; graph: LocalGraphResponse }
  | { status: 'error'; message: string }
  /** Offline, and this device holds no copy of the document's map rows. */
  | { status: 'offline' }

function graphErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server, so the graph can’t load.'
  return 'Couldn’t load the graph.'
}

/**
 * Local graph on the document page (R20, T71): the document and everything 2
 * steps out (note links, tags, its repo, semantic neighbours, ghosts), as a
 * force-directed graph or as a list. The list is the screen-reader
 * alternative and the default under 640 px. Offline it is built on the device
 * from the synced map rows (T72); it needs a connection only when this device
 * holds no copy of the document.
 */
export function LocalGraphPanel({ id }: { id: number }) {
  const online = useOnline()
  const headingId = useId()
  const wide = useMediaQuery(GRAPH_DEFAULT_QUERY)
  // Null until the owner picks a view; then their choice wins over the width.
  const [chosen, setChosen] = useState<View | null>(null)
  const view: View = chosen ?? (wide ? 'graph' : 'list')
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Bumped by Retry; each value loads the graph again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    if (!online) {
      // Offline: built on the device from the synced map rows (T72).
      offlineLocalGraph(id)
        .then((graph) => {
          if (!controller.signal.aborted) setState(graph === null ? { status: 'offline' } : { status: 'done', graph })
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ status: 'offline' })
        })
      return () => controller.abort()
    }
    getLocalGraph(id, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        if (isLocalGraphResponse(response)) setState({ status: 'done', graph: response })
        else setState({ status: 'error', message: graphErrorMessage(null) })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: graphErrorMessage(error) })
      })
    return () => controller.abort()
  }, [id, online, attempt])

  const retry = (): void => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  const graph = state.status === 'done' && state.graph.inMap && connectedCount(state.graph) > 0 ? state.graph : null

  let body
  if (state.status === 'offline') body = <PanelNote>The graph needs a connection.</PanelNote>
  else if (state.status === 'loading')
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Building the graph…
      </p>
    )
  else if (state.status === 'error')
    body = (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-danger">
        <span className="flex-1">{state.message}</span>
        <button
          type="button"
          onClick={retry}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
        >
          <RotateCw aria-hidden="true" className="size-4" />
          Retry
        </button>
      </div>
    )
  else if (!state.graph.inMap)
    body = (
      <PanelNote>
        This document isn’t part of the knowledge map (repo code, config and licence files, and documents with no indexed
        text are left out), so it has no graph.
      </PanelNote>
    )
  else if (graph === null)
    body = (
      <PanelNote>
        Nothing is connected to this document yet: no links, tags or related documents. A document indexed a moment ago gets
        its connections when the current index round ends.
      </PanelNote>
    )
  else
    body = (
      <>
        {view === 'graph' ? (
          <Suspense fallback={<p role="status" className="flex h-88 items-center justify-center gap-2 text-sm text-muted md:h-112"><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Drawing the graph…</p>}>
            <GraphCanvas graph={graph} center={graph.center} title="Local Atlas" subtitle={`${connectedCount(graph)} connected`} />
          </Suspense>
        ) : (
          <GraphList graph={graph} />
        )}
        <Legend graph={graph} />
        {graph.truncated ? (
          <p className="mt-2 text-xs text-muted">Only the best connected items are shown; this document has more.</p>
        ) : null}
      </>
    )

  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto mt-6 w-full max-w-5xl rounded-card border border-line/60 bg-surface p-5 shadow-[0_1px_2px_rgb(15_15_16/0.05)] md:p-6"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
          <Network aria-hidden="true" className="size-4 text-muted" />
          Graph
        </h2>
        {graph === null ? null : (
          <div role="group" aria-label="Graph view" className="inline-flex rounded-control bg-raised p-1">
            <ViewButton current={view} value="graph" onPick={setChosen}>
              Graph
            </ViewButton>
            <ViewButton current={view} value="list" onPick={setChosen}>
              List
            </ViewButton>
          </div>
        )}
      </div>
      {body}
    </section>
  )
}

function ViewButton({
  current,
  value,
  onPick,
  children,
}: {
  current: View
  value: View
  onPick: (view: View) => void
  children: string
}) {
  const active = current === value
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onPick(value)}
      className={`inline-flex min-h-11 min-w-16 items-center justify-center rounded-[0.5rem] px-3 text-sm transition-colors ${
        active ? 'bg-strong font-medium text-on-strong' : 'text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function PanelNote({ children }: { children: string }) {
  return <p className="text-sm text-muted">{children}</p>
}

function Legend({ graph }: { graph: LocalGraphResponse }) {
  return (
    <ul aria-label="Colours" className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {tonesIn(graph).map((tone) => (
        <li key={tone} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`size-2.5 rounded-full ${TONE_SWATCH[tone]}`} />
          {TONE_LABELS[tone]}
        </li>
      ))}
    </ul>
  )
}

function GraphList({ graph }: { graph: LocalGraphResponse }) {
  return (
    <div className="space-y-4">
      {listGroups(graph).map((group) => (
        <div key={group.depth}>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{group.title}</h3>
          <ul className="divide-y divide-line">
            {group.entries.map((entry) => (
              <GraphListItem key={entry.node.id} entry={entry} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function GraphListItem({ entry }: { entry: ListEntry }) {
  const { node, tone, reason } = entry
  const kind = node.type === 'document' ? (node.sourceLabel ?? TONE_LABELS[tone]) : TONE_LABELS[tone]
  const opens = node.type === 'document' && node.documentId !== null
  const path = opens ? documentPath(node.documentId!) : node.type === 'repo' ? repoPath(node.label) : null
  return (
    <li className="flex min-h-11 items-start gap-3 py-2">
      <span aria-hidden="true" className={`mt-2 size-2.5 shrink-0 rounded-full ${TONE_SWATCH[tone]}`} />
      <div className="min-w-0 flex-1">
        {path === null ? (
          <p className={`text-[0.9375rem] wrap-break-word ${node.type === 'ghost' ? 'text-muted' : 'text-ink'}`}>
            {node.type === 'tag' ? `#${node.label}` : node.label}
          </p>
        ) : (
          <a
            href={path}
            onClick={(event) => followLink(event, path)}
            className="-mx-2 -my-1 inline-flex min-h-11 items-center rounded-control px-2 text-[0.9375rem] font-medium wrap-break-word text-ink transition-colors hover:bg-raised"
          >
            {node.label}
          </a>
        )}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span>{kind}</span>
          {reason === '' ? null : <span>{reason}</span>}
          <span>
            {node.links} {node.links === 1 ? 'link' : 'links'}
          </span>
          {node.allowLlm === false ? (
            <span className="inline-flex items-center gap-1" title="Never sent to Gemini">
              <Lock aria-hidden="true" className="size-3.5" />
              Local only
            </span>
          ) : null}
        </p>
      </div>
    </li>
  )
}

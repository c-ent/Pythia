import { LoaderCircle, Lock, RotateCw, Waypoints } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { ApiError } from '../api/client'
import { getRelated, type RelatedDocument, type RelatedResponse, type ScoreBand } from '../api/related'
import { useOnline } from '../hooks/useOnline'
import { offlineRelated } from '../offline/offlineMap'
import { documentPath, followLink } from '../router'
import { SourceBadge } from '../search/SourceBadge'
import { headingTrail } from '../search/format'

type LoadState =
  | { status: 'loading' }
  | { status: 'done'; response: RelatedResponse }
  | { status: 'error'; message: string }
  /** Offline, and this device holds no copy of the document's map rows. */
  | { status: 'offline' }

const BAND_LABELS: Record<ScoreBand, string> = { strong: 'Strong match', medium: 'Medium match', weak: 'Weak match' }

function relatedErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server, so related documents can’t load.'
  return 'Couldn’t load related documents.'
}

/** Guards against a server without the related route answering with something else. */
function isRelatedResponse(value: unknown): value is RelatedResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'related' in value &&
    Array.isArray(value.related) &&
    'inMap' in value &&
    typeof value.inMap === 'boolean'
  )
}

/**
 * Related panel on the document page (R20, T67): up to 8 semantic neighbours
 * from any source, each with its source, title, score band and the passage
 * that links it. The list comes from the server (stored vectors, no Ollama
 * call); offline it comes from the synced copy (T72), without passages, and
 * says it needs a connection only when this device has no copy of the
 * document. Passage text is plain text, rendered as text, never as HTML.
 */
export function RelatedPanel({ id }: { id: number }) {
  const online = useOnline()
  const headingId = useId()
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Bumped by Retry; each value loads the list again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    if (!online) {
      // Offline: the synced copy's stored list (T72), or a note when this device has none.
      offlineRelated(id)
        .then((response) => {
          if (!controller.signal.aborted) setState(response === null ? { status: 'offline' } : { status: 'done', response })
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ status: 'offline' })
        })
      return () => controller.abort()
    }
    getRelated(id, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return
        if (isRelatedResponse(response)) setState({ status: 'done', response })
        else setState({ status: 'error', message: relatedErrorMessage(null) })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: relatedErrorMessage(error) })
      })
    return () => controller.abort()
  }, [id, online, attempt])

  const retry = (): void => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  let body
  if (state.status === 'offline') body = <PanelNote>Related documents need a connection.</PanelNote>
  else if (state.status === 'loading')
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Finding related documents…
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
  else if (!state.response.inMap)
    body = (
      <PanelNote>
        This document isn’t part of the knowledge map (repo code, config and licence files, and documents with no indexed
        text are left out), so it has no related documents.
      </PanelNote>
    )
  else if (state.response.related.length === 0)
    body = (
      <PanelNote>
        No related documents found. A document indexed a moment ago gets its list when the current index round ends.
      </PanelNote>
    )
  else
    body = (
      <ol className="divide-y divide-line">
        {state.response.related.map((doc) => (
          <RelatedItem key={doc.documentId} doc={doc} />
        ))}
      </ol>
    )

  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto mt-6 w-full max-w-5xl rounded-card border border-line/60 bg-surface p-5 shadow-[0_1px_2px_rgb(15_15_16/0.05)] md:p-6"
    >
      <h2 id={headingId} className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Waypoints aria-hidden="true" className="size-4 text-muted" />
        Related
      </h2>
      {body}
    </section>
  )
}

function PanelNote({ children }: { children: string }) {
  return <p className="text-sm text-muted">{children}</p>
}

function RelatedItem({ doc }: { doc: RelatedDocument }) {
  const path = documentPath(doc.documentId)
  const trail = doc.passage === null ? null : headingTrail({ title: doc.title, headingPath: doc.passage.headingPath })
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <SourceBadge source={doc.source} />
        <span
          className={`rounded-full bg-raised px-2 py-0.5 ${doc.band === 'strong' ? 'font-medium text-accent-ink' : 'text-muted'}`}
        >
          {BAND_LABELS[doc.band]}
        </span>
        {doc.allowLlm ? null : (
          <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-muted" title="Never sent to Gemini">
            <Lock aria-hidden="true" className="size-3.5" />
            Local only
          </span>
        )}
      </div>
      <a
        href={path}
        onClick={(event) => followLink(event, path)}
        className="-mx-2 mt-1 flex min-h-11 items-center rounded-control px-2 text-[0.9375rem] font-medium wrap-break-word text-ink transition-colors hover:bg-raised"
      >
        {doc.title}
      </a>
      {doc.passage === null ? null : (
        <div className="mt-1 text-sm text-muted">
          {trail === null ? null : <p className="truncate text-xs">{trail}</p>}
          <p className="mt-0.5 wrap-break-word whitespace-pre-line">
            {doc.passage.truncated ? `${doc.passage.text}…` : doc.passage.text}
          </p>
        </div>
      )}
    </li>
  )
}

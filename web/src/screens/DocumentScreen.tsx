import { ArrowLeft, HardDrive, LoaderCircle, Lock, RotateCw, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { DocumentView } from '../api/documents'
import { BacklinksPanel } from '../document/BacklinksPanel'
import { CopyPath, OpenInObsidian } from '../document/DocumentActions'
import { canRetry, documentErrorMessage, truncationNote } from '../document/format'
import { loadDocument } from '../document/loadDocument'
import { hasNoteLinks, linkTargets } from '../document/noteLinks'
import { RelatedPanel } from '../document/RelatedPanel'
import { useBacklinks } from '../document/useBacklinks'
import { LocalGraphPanel } from '../map/LocalGraphPanel'
import { formatDate } from '../repos/format'
import { goBack, pathFor } from '../router'
import { SourceBadge } from '../search/SourceBadge'

// The Markdown renderer and highlight.js grammars are most of the app's
// JavaScript, so they load only when a document opens. The service worker
// still precaches the chunk, so documents open offline too.
const DocumentBody = lazy(() => import('../document/DocumentBody').then((module) => ({ default: module.DocumentBody })))

type LoadState =
  | { status: 'loading' }
  | { status: 'done'; doc: DocumentView; cached: boolean }
  | { status: 'error'; message: string; retry: boolean }

/**
 * One document, opened from a search result or an Ask source (R6): a header
 * with the title, source and copyable file path, then the rendered text.
 * The shell mounts it with `key={id}`, so a new id starts from loading.
 */
export function DocumentScreen({ id }: { id: number }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Bumped by Retry; each value loads the document again.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    loadDocument(id, controller.signal)
      .then(({ doc, cached }) => {
        if (!controller.signal.aborted) setState({ status: 'done', doc, cached })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: documentErrorMessage(error), retry: canRetry(error) })
      })
    return () => controller.abort()
  }, [id, attempt])

  useEffect(() => {
    if (state.status === 'done') document.title = `${state.doc.title} · Pythia`
  }, [state])

  const retry = (): void => {
    setState({ status: 'loading' })
    setAttempt((n) => n + 1)
  }

  // Backlinks and the note's resolved links: notes only (Obsidian, Keep), once the document opened.
  const backlinks = useBacklinks(id, state.status === 'done' && hasNoteLinks(state.doc.source.kind))
  const outgoing = backlinks.state.status === 'done' ? backlinks.state.response.outgoing : null
  const targets = useMemo(() => (outgoing === null ? undefined : linkTargets(outgoing)), [outgoing])

  return (
    <>
      <button
        type="button"
        onClick={() => goBack(pathFor('search'))}
        className="-ml-3 mb-4 inline-flex min-h-11 items-center gap-2 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back
      </button>
      {state.status === 'loading' ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Opening document…
        </p>
      ) : state.status === 'error' ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">{state.message}</span>
          {state.retry ? (
            <button
              type="button"
              onClick={retry}
              className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised"
            >
              <RotateCw aria-hidden="true" className="size-4" />
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <article className="mx-auto w-full max-w-5xl rounded-card border border-line/60 bg-surface p-5 shadow-[0_1px_2px_rgb(15_15_16/0.05)] md:p-8">
          <DocumentHeader doc={state.doc} cached={state.cached} />
          <Suspense
            fallback={
              <p role="status" className="flex items-center gap-2 text-sm text-muted">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                Rendering…
              </p>
            }
          >
            <DocumentBody doc={state.doc} targets={targets} />
          </Suspense>
        </article>
      )}
      {state.status === 'done' ? <BacklinksPanel state={backlinks.state} retry={backlinks.retry} /> : null}
      {state.status === 'done' ? <RelatedPanel id={id} /> : null}
      {state.status === 'done' ? <LocalGraphPanel id={id} /> : null}
    </>
  )
}

function DocumentHeader({ doc, cached }: { doc: DocumentView; cached: boolean }) {
  const note = truncationNote(doc)
  const updated = doc.mtime ?? doc.updatedAt
  return (
    <header className="mb-6 border-b border-line pb-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
        <SourceBadge source={doc.source} />
        {doc.allowLlm ? null : (
          <span className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5" title="Never sent to Gemini">
            <Lock aria-hidden="true" className="size-3.5" />
            Local only
          </span>
        )}
        {cached ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5"
            title="Read from the copy saved on this device"
          >
            <HardDrive aria-hidden="true" className="size-3.5" />
            Saved copy
          </span>
        ) : null}
      </div>
      <h1 className="mt-3 text-2xl leading-tight font-semibold tracking-tight break-words md:text-[1.875rem]">
        {doc.title}
      </h1>
      <p className="mt-2 text-[0.8125rem] text-muted">
        Updated <time dateTime={updated}>{formatDate(updated)}</time>
      </p>
      <CopyPath path={doc.path} />
      <div className="mt-1 empty:hidden">
        <OpenInObsidian doc={doc} />
      </div>
      {note === null ? null : <p className="mt-3 text-sm text-warning">{note}</p>}
    </header>
  )
}

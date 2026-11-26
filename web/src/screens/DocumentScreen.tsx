import { ArrowLeft, Check, Copy, HardDrive, LoaderCircle, Lock, RotateCw, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { DocumentView } from '../api/documents'
import { canRetry, documentErrorMessage, truncationNote } from '../document/format'
import { loadDocument } from '../document/loadDocument'
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
        <article>
          <DocumentHeader doc={state.doc} cached={state.cached} />
          <Suspense
            fallback={
              <p role="status" className="flex items-center gap-2 text-sm text-muted">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                Rendering…
              </p>
            }
          >
            <DocumentBody doc={state.doc} />
          </Suspense>
        </article>
      )}
    </>
  )
}

function DocumentHeader({ doc, cached }: { doc: DocumentView; cached: boolean }) {
  const note = truncationNote(doc)
  const updated = doc.mtime ?? doc.updatedAt
  return (
    <header className="mb-6 border-b border-line pb-4">
      <h1 className="text-2xl font-semibold tracking-tight break-words">{doc.title}</h1>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
        <SourceBadge source={doc.source} />
        {doc.allowLlm ? null : (
          <span className="inline-flex items-center gap-1" title="Never sent to Gemini">
            <Lock aria-hidden="true" className="size-3.5" />
            Local only
          </span>
        )}
        {cached ? (
          <span className="inline-flex items-center gap-1" title="Read from the copy saved on this device">
            <HardDrive aria-hidden="true" className="size-3.5" />
            Saved copy
          </span>
        ) : null}
        <span>
          Updated <time dateTime={updated}>{formatDate(updated)}</time>
        </span>
      </div>
      <CopyPath path={doc.path} />
      {note === null ? null : <p className="mt-3 text-sm text-warning">{note}</p>}
    </header>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'

function CopyPath({ path }: { path: string }) {
  const [copy, setCopy] = useState<CopyState>('idle')

  useEffect(() => {
    if (copy === 'idle') return
    const timer = window.setTimeout(() => setCopy('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copy])

  const onCopy = (): void => {
    // `navigator.clipboard` exists only in secure contexts (HTTPS, localhost).
    const clipboard = typeof navigator.clipboard?.writeText === 'function' ? navigator.clipboard : null
    if (clipboard === null) {
      setCopy('failed')
      return
    }
    clipboard.writeText(path).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    )
  }

  return (
    <div className="mt-2 flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 truncate font-mono text-sm text-muted" title={path}>
        {path}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy file path"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        {copy === 'copied' ? (
          <Check aria-hidden="true" className="size-4 text-success" />
        ) : (
          <Copy aria-hidden="true" className="size-4" />
        )}
      </button>
      <span role="status" className="sr-only">
        {copy === 'copied' ? 'Path copied' : copy === 'failed' ? 'Couldn’t copy the path' : ''}
      </span>
    </div>
  )
}

import { LoaderCircle, Lock, Maximize2, TriangleAlert } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { DocumentView } from '../api/documents'
import type { SearchResult } from '../api/search'
import { CopyPath, OpenInObsidian } from '../document/DocumentActions'
import { documentErrorMessage } from '../document/format'
import { loadDocument } from '../document/loadDocument'
import { documentPath, followLink } from '../router'
import { headingTrail } from './format'
import { SourceBadge } from './SourceBadge'

// Same lazy chunk as the Document screen.
const DocumentBody = lazy(() => import('../document/DocumentBody').then((module) => ({ default: module.DocumentBody })))

type State = { status: 'loading' } | { status: 'done'; doc: DocumentView } | { status: 'error'; message: string }

/**
 * The selected result's document beside the results on wide screens (R6),
 * with Copy path, Open in Obsidian and a link to the full page. Mount it with
 * `key={documentId}` so a new document starts from loading.
 */
export function PreviewPane({ result }: { result: SearchResult }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    loadDocument(result.documentId, controller.signal).then(
      ({ doc }) => {
        if (!controller.signal.aborted) setState({ status: 'done', doc })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: documentErrorMessage(error) })
      },
    )
    return () => controller.abort()
  }, [result.documentId])

  const href = documentPath(result.documentId)
  const trail = headingTrail(result)
  return (
    <aside
      aria-label="Preview"
      className="sticky top-4 flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden rounded-card border border-line bg-surface"
    >
      <header className="border-b border-line p-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 pt-2 text-lg font-semibold break-words">{result.title}</h2>
          <a
            href={href}
            onClick={(event) => followLink(event, href)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <Maximize2 aria-hidden="true" className="size-4" />
            Open page
          </a>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <SourceBadge source={result.source} />
          {trail === null ? null : <span className="min-w-0 break-words">{trail}</span>}
          {result.allowLlm ? null : (
            <span className="inline-flex items-center gap-1" title="Never sent to Gemini">
              <Lock aria-hidden="true" className="size-3.5" />
              Local only
            </span>
          )}
        </div>
        <CopyPath path={result.path} />
        <div className="mt-1 empty:hidden">
          <OpenInObsidian doc={result} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {state.status === 'loading' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Loading preview…
          </p>
        ) : state.status === 'error' ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-danger">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : (
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
        )}
      </div>
    </aside>
  )
}

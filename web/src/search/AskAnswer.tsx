import { LoaderCircle, Lock, Sparkles, TriangleAlert } from 'lucide-react'
import { useId, type MouseEvent } from 'react'
import type { AskCitation, AskResponse } from '../api/ask'
import { documentPath, followLink } from '../router'
import { engineNote, splitCitations } from './citations'
import { EngineBadge } from './EngineBadge'
import { headingTrail } from './format'
import { Highlighted } from './Highlighted'
import { SourceBadge } from './SourceBadge'

export type AnswerState =
  | { status: 'loading' }
  | { status: 'done'; response: AskResponse }
  | { status: 'error'; message: string }

/**
 * The Ask answer card (R8): the generated answer with `[n]` markers that jump
 * to its numbered sources, the engine badge, and a note when a fallback ran.
 * With engine `retrieval` the sources' snippets are the answer.
 */
export function AskAnswer({ state }: { state: AnswerState }) {
  const headingId = useId()
  // useId output can hold characters that are awkward in a fragment.
  const sourceIdPrefix = `src-${headingId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  if (state.status === 'done' && state.response.answer === null && state.response.citations.length === 0) return null

  return (
    <section aria-labelledby={headingId} aria-busy={state.status === 'loading'} className="rounded-card border border-accent/40 bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-medium">
          <Sparkles aria-hidden="true" className="size-4 text-accent-ink" />
          Answer
        </h2>
        {state.status === 'done' ? <EngineBadge engine={state.response.engine} model={state.response.model} /> : null}
      </div>
      <AnswerBody state={state} sourceIdPrefix={sourceIdPrefix} />
    </section>
  )
}

function AnswerBody({ state, sourceIdPrefix }: { state: AnswerState; sourceIdPrefix: string }) {
  if (state.status === 'loading') {
    return (
      <p aria-live="polite" className="mt-3 flex items-center gap-2 text-sm text-muted">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
        Writing an answer…
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-danger">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {state.message}
      </p>
    )
  }

  const { response } = state
  const note = engineNote(response)
  const sourceId = (n: number): string => `${sourceIdPrefix}-${n}`
  return (
    <>
      {note === null ? null : <p className="mt-1 text-sm break-words text-muted">{note}</p>}
      {response.answer === null ? null : (
        <p aria-live="polite" className="mt-3 text-base leading-relaxed break-words whitespace-pre-line">
          <AnswerText answer={response.answer} citations={response.citations} sourceId={sourceId} />
        </p>
      )}
      {response.citations.length === 0 ? null : (
        <>
          <h3 className="mt-4 text-sm font-medium text-muted">Sources</h3>
          <ol className="mt-2 space-y-3">
            {response.citations.map((citation) => (
              <Source
                key={citation.chunkId}
                id={sourceId(citation.n)}
                citation={citation}
                showSnippet={response.answer === null}
              />
            ))}
          </ol>
        </>
      )}
    </>
  )
}

/** The answer with its `[n]` markers as links that focus the source with id `sourceId(n)`. */
export function AnswerText({
  answer,
  citations,
  sourceId,
}: {
  answer: string
  citations: AskCitation[]
  sourceId: (n: number) => string
}) {
  const known = new Set(citations.map((citation) => citation.n))
  const jump = (n: number) => (event: MouseEvent<HTMLAnchorElement>) => {
    // Scroll to the source without putting a fragment in the address bar.
    const target = document.getElementById(sourceId(n))
    if (target === null) return
    event.preventDefault()
    target.scrollIntoView?.({ block: 'nearest' })
    target.focus({ preventScroll: true })
  }
  return (
    <>
      {splitCitations(answer, known).map((segment, i) =>
        segment.kind === 'text' ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <a
            key={i}
            href={`#${sourceId(segment.n)}`}
            onClick={jump(segment.n)}
            className="mx-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-raised px-1 align-super font-mono text-[0.7rem] leading-4 text-accent-ink no-underline hover:bg-accent hover:text-on-accent"
          >
            <span className="sr-only">source </span>
            {segment.n}
          </a>
        ),
      )}
    </>
  )
}

/** One numbered source (a list item that `[n]` markers focus), with its snippet when `showSnippet`. */
export function Source({ id, citation, showSnippet }: { id: string; citation: AskCitation; showSnippet: boolean }) {
  const trail = headingTrail(citation)
  return (
    <li id={id} tabIndex={-1} className="flex gap-3 rounded-control outline-accent-ink focus:outline-2 focus:outline-offset-2">
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-raised font-mono text-xs text-muted"
      >
        {citation.n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium break-words">
          <span className="sr-only">Source {citation.n}: </span>
          <a
            href={documentPath(citation.documentId)}
            onClick={(event) => followLink(event, documentPath(citation.documentId))}
            className="text-ink underline decoration-line underline-offset-4 hover:decoration-accent"
          >
            {citation.title}
          </a>
          {trail === null ? null : <span className="font-normal text-muted">{` › ${trail}`}</span>}
        </p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <SourceBadge source={citation.source} />
          <span className="min-w-0 truncate font-mono" title={citation.path}>
            {citation.path}
          </span>
          {citation.allowLlm ? null : (
            <span className="inline-flex items-center gap-1" title="Never sent to Gemini">
              <Lock aria-hidden="true" className="size-3.5" />
              Local only
            </span>
          )}
        </div>
        {showSnippet ? (
          <p className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-line">
            <Highlighted snippet={citation.snippet} />
          </p>
        ) : null}
      </div>
    </li>
  )
}

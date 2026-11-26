import {
  ArrowUp,
  Check,
  Copy,
  Info,
  LoaderCircle,
  Lock,
  MessageSquareText,
  Plus,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react'
import { askQuestion, type AskResponse } from '../api/ask'
import { getRecentQueries } from '../api/recent'
import type { SourceKind } from '../api/search'
import { ScreenHeader } from '../components/Screen'
import { useClipboard } from '../hooks/useClipboard'
import { useOnline } from '../hooks/useOnline'
import { AnswerText, Source, type AnswerState } from '../search/AskAnswer'
import { engineNote } from '../search/citations'
import { askErrorMessage } from '../search/format'
import { SourceChips } from '../search/SourceChips'
import { answerForCopy, askMemory, ENGINE_STEPS, engineLabel, sourceCount, type AskTurn } from './ask'
import { TRY_ASKING_EXAMPLES } from './home'

const SUGGESTIONS_SHOWN = 5

const outlineButton =
  'inline-flex min-h-11 items-center gap-1.5 rounded-control border border-line px-3.5 text-sm font-medium text-ink transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The Ask page (R6, R8): one question at a time with its cited answer, the
 * answer-engine chain and the sources beside it (below it on narrow screens),
 * and a box for the next question. The server keeps no conversation, so a
 * follow-up is a new question.
 */
export function AskScreen() {
  const online = useOnline()
  const [draft, setDraft] = useState('')
  const [sources, setSources] = useState<SourceKind[]>(() => askMemory.sources)
  const [turn, setTurn] = useState<AskTurn | null>(() => askMemory.turn)
  const [snippetsOnly, setSnippetsOnly] = useState(false)
  const pending = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // useId output can hold characters that are awkward in a fragment.
  const idBase = `ask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const sourceId = (n: number): string => `${idBase}-src-${n}`

  // Sends the question; the caller has already shown it as loading.
  const request = useCallback((question: string, kinds: SourceKind[]): void => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const settle = (state: AnswerState): void => {
      if (!controller.signal.aborted) setTurn({ question, sources: kinds, state })
    }
    askQuestion({ question, ...(kinds.length > 0 ? { sources: kinds } : {}) }, controller.signal).then(
      (response) => settle({ status: 'done', response }),
      (error: unknown) => settle({ status: 'error', message: askErrorMessage(error, false) }),
    )
  }, [])

  const ask = (question: string, kinds: SourceKind[]): void => {
    setSnippetsOnly(false)
    setTurn({ question, sources: kinds, state: { status: 'loading' } })
    request(question, kinds)
  }

  // Back from a source: a question that was still loading is asked again.
  useEffect(() => {
    const kept = askMemory.turn
    if (kept?.state.status === 'loading') request(kept.question, kept.sources)
    const controllers = pending
    return () => controllers.current?.abort()
  }, [request])

  useEffect(() => {
    askMemory.turn = turn
    askMemory.sources = sources
  }, [turn, sources])

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '' || !online) return
    setDraft('')
    ask(text, sources)
  }

  const startOver = (): void => {
    pending.current?.abort()
    pending.current = null
    setTurn(null)
    setDraft('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const box = (label: string, placeholder: string, className = '') => (
    <QuestionForm
      label={label}
      placeholder={placeholder}
      value={draft}
      onChange={setDraft}
      sources={sources}
      onSources={setSources}
      onSubmit={submit}
      online={online}
      inputRef={inputRef}
      className={className}
    />
  )

  if (turn === null) {
    return (
      <div className="mx-auto max-w-3xl">
        <ScreenHeader title="Ask" description="Questions answered from your notes and repos, with sources." />
        {box('Ask a question about your notes and code', 'Ask a question about your notes and code…')}
        <Suggestions online={online} onAsk={(question) => ask(question, sources)} />
      </div>
    )
  }

  const response = turn.state.status === 'done' ? turn.state.response : null
  // Snippets replace the answer when asked to, or when no model answered.
  const showSnippets = response !== null && (snippetsOnly || response.answer === null)

  return (
    <>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <article aria-busy={turn.state.status === 'loading'} className="min-w-0">
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight break-words">{turn.question}</h1>
            <button type="button" onClick={startOver} className={`${outlineButton} shrink-0`}>
              <Plus aria-hidden="true" className="size-4" />
              New question
            </button>
          </div>
          {turn.state.status === 'loading' ? (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Writing an answer…
            </p>
          ) : turn.state.status === 'error' ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span className="flex-1">{turn.state.message}</span>
              <button
                type="button"
                disabled={!online}
                onClick={() => ask(turn.question, turn.sources)}
                className="-my-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-3 text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCw aria-hidden="true" className="size-4" />
                Retry
              </button>
            </div>
          ) : (
            <AnswerView
              response={turn.state.response}
              showSnippets={showSnippets}
              snippetsOnly={snippetsOnly}
              onSnippetsOnly={setSnippetsOnly}
              sourceId={sourceId}
            />
          )}
        </article>
        <div className="min-w-0 space-y-4 lg:sticky lg:top-4">
          <EnginePanel used={response?.engine ?? null} model={response?.model ?? null} />
          {response === null || showSnippets || response.citations.length === 0 ? null : (
            <SourcesPanel response={response} sourceId={sourceId} />
          )}
        </div>
      </div>
      {box('Ask a follow-up question', 'Ask a follow-up question…', 'mt-8')}
    </>
  )
}

function AnswerView({
  response,
  showSnippets,
  snippetsOnly,
  onSnippetsOnly,
  sourceId,
}: {
  response: AskResponse
  showSnippets: boolean
  snippetsOnly: boolean
  onSnippetsOnly: (next: boolean) => void
  sourceId: (n: number) => string
}) {
  const [copy, copyText] = useClipboard()
  const note = engineNote(response)

  if (response.answer === null && response.citations.length === 0) {
    return (
      <p role="status" className="mt-4 text-sm text-muted">
        Nothing in your notes, repos or Keep matches this question. Try other words or turn off a source filter.
      </p>
    )
  }

  return (
    <>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink" title={response.model ?? undefined}>
          <Sparkles aria-hidden="true" className="size-4 text-accent-ink" />
          {response.answer === null ? 'Matching passages' : `Answered by ${engineLabel(response.engine)}`}
        </span>
        <span>{sourceCount(response.citations.length)}</span>
      </p>
      {showSnippets ? (
        <>
          {response.answer === null ? null : (
            <p className="mt-4 text-sm text-muted">Showing the matching passages instead of the answer.</p>
          )}
          <h2 className="sr-only">Sources</h2>
          <ol className="mt-4 space-y-4">
            {response.citations.map((citation) => (
              <Source key={citation.chunkId} id={sourceId(citation.n)} citation={citation} showSnippet />
            ))}
          </ol>
        </>
      ) : (
        <p aria-live="polite" className="mt-4 text-base leading-relaxed break-words whitespace-pre-line">
          <AnswerText answer={response.answer ?? ''} citations={response.citations} sourceId={sourceId} />
        </p>
      )}
      {note === null ? null : (
        <p className="mt-4 flex items-start gap-2 rounded-control bg-raised px-3 py-2.5 text-[0.8125rem] leading-snug text-ink/80">
          {response.withheld > 0 ? (
            <Lock aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-ink" />
          ) : (
            <Info aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-ink" />
          )}
          {note}
        </p>
      )}
      {response.answer === null ? null : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => copyText(answerForCopy(response))} className={outlineButton}>
            {copy === 'copied' ? (
              <Check aria-hidden="true" className="size-4 text-success" />
            ) : (
              <Copy aria-hidden="true" className="size-4" />
            )}
            Copy answer
          </button>
          <button
            type="button"
            aria-pressed={snippetsOnly}
            onClick={() => onSnippetsOnly(!snippetsOnly)}
            className={`${outlineButton} aria-pressed:border-strong aria-pressed:bg-raised`}
          >
            Show only snippets
          </button>
          <span role="status" className="sr-only">
            {copy === 'copied' ? 'Answer copied' : copy === 'failed' ? 'Couldn’t copy the answer' : ''}
          </span>
        </div>
      )}
    </>
  )
}

function EnginePanel({ used, model }: { used: AskResponse['engine'] | null; model: string | null }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="rounded-card border border-line bg-surface p-4">
      <h2 id={headingId} className="text-sm font-medium">
        Answer engine
      </h2>
      <ol className="mt-3 space-y-2">
        {ENGINE_STEPS.map((step, i) => {
          const current = step.engine === used
          return (
            <li
              key={step.engine}
              aria-current={current ? 'step' : undefined}
              title={current ? (model ?? undefined) : undefined}
              className={`flex items-center gap-3 rounded-control border px-3 py-2 ${current ? 'border-strong' : 'border-line'}`}
            >
              <span
                aria-hidden="true"
                className="grid size-6 shrink-0 place-items-center rounded-full bg-raised font-mono text-xs text-muted"
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{step.label}</span>
                <span className="block text-xs text-muted">{step.when}</span>
              </span>
              {current ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink">
                  <Check aria-hidden="true" className="size-3.5" />
                  Used<span className="sr-only"> for this answer</span>
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function SourcesPanel({ response, sourceId }: { response: AskResponse; sourceId: (n: number) => string }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="rounded-card border border-line bg-surface p-4">
      <h2 id={headingId} className="text-sm font-medium">
        Sources
      </h2>
      <ol className="mt-3 space-y-3">
        {response.citations.map((citation) => (
          <Source key={citation.chunkId} id={sourceId(citation.n)} citation={citation} showSnippet={false} />
        ))}
      </ol>
    </section>
  )
}

function QuestionForm({
  label,
  placeholder,
  value,
  onChange,
  sources,
  onSources,
  onSubmit,
  online,
  inputRef,
  className,
}: {
  label: string
  placeholder: string
  value: string
  onChange: (next: string) => void
  sources: SourceKind[]
  onSources: (next: SourceKind[]) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  online: boolean
  inputRef: RefObject<HTMLInputElement | null>
  className: string
}) {
  const inputId = useId()
  return (
    <form
      onSubmit={onSubmit}
      className={`flex flex-col gap-3 rounded-3xl border border-line/60 bg-surface p-4 shadow-[0_1px_2px_rgb(15_15_16/0.06),0_12px_40px_rgb(15_15_16/0.08)] ${className}`}
    >
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          enterKeyHint="send"
          autoComplete="off"
          maxLength={1000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="block min-h-11 min-w-0 flex-1 rounded-control bg-transparent px-1 text-base text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent-ink"
        />
        <button
          type="submit"
          aria-label="Ask"
          disabled={value.trim() === '' || !online}
          className="grid size-11 shrink-0 place-items-center rounded-control bg-strong text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </button>
      </div>
      <SourceChips value={sources} onChange={onSources} />
      <p className="flex items-start gap-2 text-[0.8125rem] leading-snug text-ink/80">
        <Lock aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-ink" />
        {online
          ? 'Answers come from Gemini. Locked notes stay out of it and fall back to the local model or snippets.'
          : 'You’re offline. Ask needs a connection.'}
      </p>
    </form>
  )
}

/** Recent questions from the server (R14), or fixed examples until there are any. */
function Suggestions({ online, onAsk }: { online: boolean; onAsk: (question: string) => void }) {
  const headingId = useId()
  const [asked, setAsked] = useState<string[]>([])

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    getRecentQueries('ask', SUGGESTIONS_SHOWN, controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setAsked(list.map((entry) => entry.query).slice(0, SUGGESTIONS_SHOWN))
      },
      () => {},
    )
    return () => controller.abort()
  }, [online])

  const questions: readonly string[] = asked.length > 0 ? asked : TRY_ASKING_EXAMPLES
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="text-sm font-medium text-muted">
        {asked.length > 0 ? 'Recent questions' : 'Try asking'}
      </h2>
      <ul className="mt-3 space-y-2">
        {questions.map((question) => (
          <li key={question}>
            <button
              type="button"
              disabled={!online}
              onClick={() => onAsk(question)}
              className="flex min-h-11 w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-left text-sm transition-colors hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MessageSquareText aria-hidden="true" className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 break-words">{question}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

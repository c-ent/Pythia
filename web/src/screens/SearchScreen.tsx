import { Info, LoaderCircle, Search, SearchX, Sparkles, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { askQuestion } from '../api/ask'
import { searchNotes, type SearchResponse, type SourceKind } from '../api/search'
import { ScreenHeader } from '../components/Screen'
import { useOnline } from '../hooks/useOnline'
import { searchOffline } from '../offline/offlineSearch'
import { AskAnswer, type AnswerState } from '../search/AskAnswer'
import { askErrorMessage, OFFLINE_MESSAGE, resultCount, SEARCH_LIMIT, searchErrorMessage } from '../search/format'
import { ResultCard } from '../search/ResultCard'
import { SourceChips } from '../search/SourceChips'

type Mode = 'search' | 'ask'

type Outcome =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'done'; query: string; response: SearchResponse; offline: boolean }
  | { status: 'error'; query: string; message: string }

const MODES: { value: Mode; label: string; icon: LucideIcon }[] = [
  { value: 'search', label: 'Search', icon: Search },
  { value: 'ask', label: 'Ask', icon: Sparkles },
]

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

export function SearchScreen() {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('search')
  const [sources, setSources] = useState<SourceKind[]>([])
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' })
  // The answer to the last query asked in Ask mode; null in Search mode.
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  const online = useOnline()
  const inputRef = useRef<HTMLInputElement>(null)
  const pending = useRef<AbortController | null>(null)
  const pendingAsk = useRef<AbortController | null>(null)
  const inputId = useId()
  const modeName = useId()

  // "/" jumps to the search box from anywhere on the screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const runAsk = async (text: string, kinds: SourceKind[]): Promise<void> => {
    const controller = new AbortController()
    pendingAsk.current = controller
    setAnswer({ status: 'loading' })
    try {
      const response = await askQuestion(
        { question: text, ...(kinds.length > 0 ? { sources: kinds } : {}) },
        controller.signal,
      )
      if (!controller.signal.aborted) setAnswer({ status: 'done', response })
    } catch (error) {
      if (!controller.signal.aborted) setAnswer({ status: 'error', message: askErrorMessage(error) })
    }
  }

  const run = async (text: string, kinds: SourceKind[], withAnswer: boolean): Promise<void> => {
    pending.current?.abort()
    pendingAsk.current?.abort()
    pendingAsk.current = null
    setAnswer(null)
    if (!online) {
      pending.current = null
      // No IndexedDB (old browser, private mode): nothing is cached to search.
      if (typeof indexedDB === 'undefined') {
        setOutcome({ status: 'error', query: text, message: OFFLINE_MESSAGE })
        return
      }
      const controller = new AbortController()
      pending.current = controller
      setOutcome({ status: 'loading', query: text })
      try {
        const results = await searchOffline({ query: text, sources: kinds })
        if (!controller.signal.aborted) {
          setOutcome({ status: 'done', query: text, response: { results, degraded: false }, offline: true })
        }
      } catch {
        if (!controller.signal.aborted) setOutcome({ status: 'error', query: text, message: OFFLINE_MESSAGE })
      }
      return
    }
    const controller = new AbortController()
    pending.current = controller
    setOutcome({ status: 'loading', query: text })
    // The answer and the full match list load side by side; the list is usually first.
    if (withAnswer) void runAsk(text, kinds)
    try {
      const response = await searchNotes(
        { query: text, limit: SEARCH_LIMIT, ...(kinds.length > 0 ? { sources: kinds } : {}) },
        controller.signal,
      )
      if (!controller.signal.aborted) setOutcome({ status: 'done', query: text, response, offline: false })
    } catch (error) {
      // A newer search replaced this one; its result is the one to show.
      if (!controller.signal.aborted) setOutcome({ status: 'error', query: text, message: searchErrorMessage(error) })
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const text = query.trim()
    if (text !== '') void run(text, sources, mode === 'ask')
  }

  const changeSources = (next: SourceKind[]): void => {
    setSources(next)
    if (outcome.status !== 'idle') void run(outcome.query, next, mode === 'ask')
  }

  const changeMode = (next: Mode): void => {
    setMode(next)
    // Leaving Ask drops its answer; asking again needs a new submit.
    if (next === 'search') {
      pendingAsk.current?.abort()
      pendingAsk.current = null
      setAnswer(null)
    }
  }

  return (
    <>
      <ScreenHeader title="Search" description="Notes, repos and Keep, ranked together." />

      <form role="search" onSubmit={submit} className="space-y-3">
        <fieldset className="inline-flex gap-1 rounded-control border border-line bg-surface p-1">
          <legend className="sr-only">Mode</legend>
          {MODES.map(({ value, label, icon: Icon }) => (
            <label
              key={value}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-control px-3 text-sm text-muted transition-colors hover:text-ink has-checked:bg-raised has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name={modeName}
                value={value}
                checked={mode === value}
                onChange={() => changeMode(value)}
                className="sr-only"
              />
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </label>
          ))}
        </fieldset>

        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <label htmlFor={inputId} className="sr-only">
              Search notes, repos and Keep
            </label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            />
            <input
              ref={inputRef}
              id={inputId}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              maxLength={1000}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === 'ask' ? 'Ask a question…' : 'Search notes, repos and Keep…'}
              className="block min-h-11 w-full rounded-control border border-line bg-surface pr-3 pl-9 text-base text-ink transition-colors placeholder:text-muted focus:border-accent"
            />
          </div>
          <button
            type="submit"
            disabled={query.trim() === ''}
            className="min-h-11 shrink-0 rounded-control bg-accent px-4 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mode === 'ask' ? 'Ask' : 'Search'}
          </button>
        </div>

        <SourceChips value={sources} onChange={changeSources} />
      </form>

      <div className="mt-6 space-y-4">
        {answer === null ? null : <AskAnswer state={answer} />}
        <Results outcome={outcome} withAnswer={answer !== null} />
      </div>
    </>
  )
}

function Results({ outcome, withAnswer }: { outcome: Outcome; withAnswer: boolean }) {
  switch (outcome.status) {
    case 'idle':
      return (
        <p className="hidden text-sm text-muted md:block">
          Press <kbd className="rounded border border-line bg-raised px-1.5 font-mono text-xs">/</kbd> to jump to the
          search box.
        </p>
      )
    case 'loading':
      return (
        <p aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          Searching…
        </p>
      )
    case 'error':
      return (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-card border border-danger/40 bg-surface px-4 py-3 text-sm text-danger"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {outcome.message}
        </p>
      )
    case 'done': {
      const { results, degraded } = outcome.response
      return (
        <div className="space-y-4">
          {outcome.offline ? (
            <p className="flex items-start gap-2 rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
              <WifiOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              You’re offline. Showing word matches from notes and pinned repos saved on this device. Ask needs a
              connection.
            </p>
          ) : null}
          {degraded ? (
            <p className="flex items-start gap-2 rounded-card border border-warning/40 bg-surface px-4 py-3 text-sm text-warning">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              Showing word matches only: meaning-based search is unavailable right now.
            </p>
          ) : null}
          {results.length === 0 ? (
            <section className="rounded-card border border-line bg-surface p-6 text-center">
              <SearchX aria-hidden="true" className="mx-auto size-8 text-muted" />
              <h2 aria-live="polite" className="mt-3 text-base font-medium break-words">
                No matches for “{outcome.query}”
              </h2>
              <p className="mt-1 text-sm text-muted">Try fewer or different words, or turn off a source filter.</p>
            </section>
          ) : (
            <>
              <h2 aria-live="polite" className="text-sm font-medium text-muted">
                {withAnswer ? `All matches · ${resultCount(results.length)}` : resultCount(results.length)}
              </h2>
              <ol className="space-y-3">
                {results.map((result) => (
                  <li key={result.chunkId}>
                    <ResultCard result={result} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )
    }
  }
}

import {
  ArrowUp,
  Info,
  LoaderCircle,
  Lock,
  Search,
  SearchX,
  Sparkles,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { askQuestion } from '../api/ask'
import { SOURCE_KINDS, searchNotes, type SearchResponse, type SearchResult, type SourceKind } from '../api/search'
import { ScreenHeader } from '../components/Screen'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useOnline } from '../hooks/useOnline'
import { searchOffline } from '../offline/offlineSearch'
import { AskAnswer, type AnswerState } from '../search/AskAnswer'
import { PreviewPane } from '../search/PreviewPane'
import { askErrorMessage, OFFLINE_MESSAGE, resultCount, SEARCH_LIMIT, searchErrorMessage } from '../search/format'
import { ResultCard } from '../search/ResultCard'
import { SourceChips } from '../search/SourceChips'
import { readProfile, useProfile } from '../profile/profile'
import { useNewSearch } from '../shell/newSearch'
import { Greeting, HomeCards } from './HomeScreen'

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

/** Wide enough for the results list and the preview pane side by side. */
export const PREVIEW_PANE_QUERY = '(min-width: 80rem)'

type ChunkId = SearchResult['chunkId']

/** Results per source, and `all` for the total, for the source chips. */
function countBySource(results: readonly SearchResult[]): Partial<Record<SourceKind | 'all', number>> {
  const counts: Partial<Record<SourceKind | 'all', number>> = { all: results.length }
  for (const kind of SOURCE_KINDS) counts[kind] = results.filter((result) => result.source.kind === kind).length
  return counts
}

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')

export function SearchScreen() {
  const [query, setQuery] = useState('')
  const profile = useProfile()
  // Profile › Opening mode picks the starting mode (from the copy cached on this device).
  const [mode, setMode] = useState<Mode>(() => readProfile().openingMode)
  const [sources, setSources] = useState<SourceKind[]>([])
  const [outcome, setOutcome] = useState<Outcome>({ status: 'idle' })
  // The answer to the last query asked in Ask mode; null in Search mode.
  const [answer, setAnswer] = useState<AnswerState | null>(null)
  // The result shown in the preview pane; null means the first one.
  const [selectedId, setSelectedId] = useState<ChunkId | null>(null)
  const wide = useMediaQuery(PREVIEW_PANE_QUERY)
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

  // New search (sidebar button, Ctrl K / ⌘ K): an empty box, ready to type.
  useNewSearch(() => {
    pending.current?.abort()
    pendingAsk.current?.abort()
    pending.current = null
    pendingAsk.current = null
    setQuery('')
    setOutcome({ status: 'idle' })
    setAnswer(null)
    setMode(readProfile().openingMode)
    inputRef.current?.focus()
  })

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
    setSelectedId(null)
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

  // Home cards: Try asking asks, a recent search runs again.
  const startFromHome = (text: string, next: Mode): void => {
    setMode(next)
    setQuery(text)
    void run(text, sources, next === 'ask')
  }

  // Home is the idle screen: nothing searched or asked yet (or New search).
  const home = outcome.status === 'idle' && answer === null

  const results = outcome.status === 'done' ? outcome.response.results : []
  // Counts are shown only unfiltered: with a filter the others would read 0.
  const counts = outcome.status === 'done' && sources.length === 0 ? countBySource(results) : undefined
  // Wide screens preview the selected result (the first until one is clicked).
  const selected: SearchResult | undefined = wide
    ? (results.find((result) => result.chunkId === selectedId) ?? results[0])
    : undefined

  const QueryIcon = mode === 'ask' ? Sparkles : Search

  const form = (
    <form
      role="search"
      onSubmit={submit}
      // The card lights up while the text field has focus, so it reads as a field to type in.
      className="flex w-full flex-col rounded-[1.5rem] border border-line bg-surface shadow-[0_1px_2px_rgb(15_15_16/0.06),0_12px_40px_rgb(15_15_16/0.08)] transition-[border-color,box-shadow] has-[[data-query]:focus]:border-accent-ink/60 has-[[data-query]:focus]:ring-4 has-[[data-query]:focus]:ring-accent/40"
    >
      <label htmlFor={inputId} className="sr-only">
        Search notes, repos and Keep
      </label>
      <div
        className="flex cursor-text items-center gap-3 px-4 pt-4 pb-3 md:px-5 md:pt-5"
        // Clicking anywhere on the text row (the icon, the padding) focuses the field.
        onMouseDown={(event) => {
          if (!(event.target instanceof HTMLInputElement)) {
            event.preventDefault()
            inputRef.current?.focus()
          }
        }}
      >
        <QueryIcon aria-hidden="true" className="size-5 shrink-0 text-muted" />
        <input
          ref={inputRef}
          id={inputId}
          data-query=""
          type="search"
          enterKeyHint={mode === 'ask' ? 'send' : 'search'}
          autoComplete="off"
          spellCheck={false}
          maxLength={1000}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === 'ask' ? 'Ask a question about your notes and code…' : 'Search your notes, repos and Keep…'}
          className="block min-h-12 w-full min-w-0 bg-transparent text-base text-ink caret-accent-ink outline-none placeholder:text-muted md:text-lg"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3 border-t border-line/70 px-3 py-3 md:px-4">
        <fieldset className="order-1 inline-flex shrink-0 gap-0.5 rounded-control bg-raised p-1">
          <legend className="sr-only">Mode</legend>
          {MODES.map(({ value, label, icon: Icon }) => (
            <label
              key={value}
              className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-[0.5625rem] px-3.5 text-sm font-medium text-ink/80 transition-colors hover:text-ink has-checked:bg-strong has-checked:text-on-strong has-focus-visible:outline-2 has-focus-visible:outline-accent-ink"
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
        {/* Phones: mode and submit on one line, the chips on their own scrolling line below.
            Wider screens: everything on one line, chips scrolling in the middle. */}
        <SourceChips
          value={sources}
          onChange={changeSources}
          counts={counts}
          className="order-3 basis-full md:order-2 md:min-w-0 md:flex-1 md:basis-0"
        />
        <button
          type="submit"
          aria-label={mode === 'ask' ? 'Ask' : 'Search'}
          disabled={query.trim() === ''}
          className="order-2 ml-auto grid size-11 shrink-0 place-items-center rounded-full bg-strong text-on-strong transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 md:order-3"
        >
          <ArrowUp aria-hidden="true" className="size-5" />
        </button>
      </div>
      {mode === 'ask' ? (
        <p className="mx-3 mb-3 flex items-start gap-2 rounded-control bg-raised px-3 py-2.5 text-[0.8125rem] leading-snug text-ink/80 md:mx-4 md:mb-4">
          <Lock aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-ink" />
          Answers come from Gemini. Notes marked private stay local and fall back to the local model or snippets.
        </p>
      ) : null}
    </form>
  )

  if (home) {
    return (
      <div className="mx-auto flex w-full max-w-[55rem] flex-col items-center gap-7 pt-2 pb-10 md:pt-8">
        <Greeting name={profile.displayName} />
        {form}
        <HomeCards
          online={online}
          timeZone={profile.timeZone}
          onAsk={(question) => startFromHome(question, 'ask')}
          onSearch={(text) => startFromHome(text, 'search')}
        />
      </div>
    )
  }

  const list = (
    <>
      <ScreenHeader title="Search" description="Notes, repos and Keep, ranked together." />
      {form}
      <div className="mt-6 space-y-4">
        {answer === null ? null : <AskAnswer state={answer} />}
        <Results
          outcome={outcome}
          withAnswer={answer !== null}
          preview={profile.notePreviews}
          selectedId={selected?.chunkId ?? null}
          onSelect={wide ? setSelectedId : undefined}
        />
      </div>
    </>
  )

  if (selected === undefined) return <div className="mx-auto max-w-3xl">{list}</div>

  return (
    <div className="grid grid-cols-[minmax(0,42rem)_minmax(0,1fr)] items-start gap-6">
      <div className="min-w-0">{list}</div>
      <PreviewPane key={selected.documentId} result={selected} />
    </div>
  )
}

function Results({
  outcome,
  withAnswer,
  preview,
  selectedId,
  onSelect,
}: {
  outcome: Outcome
  withAnswer: boolean
  preview: boolean
  selectedId: ChunkId | null
  onSelect: ((chunkId: ChunkId) => void) | undefined
}) {
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
                    <ResultCard
                      result={result}
                      preview={preview}
                      selected={result.chunkId === selectedId}
                      {...(onSelect === undefined ? {} : { onSelect: () => onSelect(result.chunkId) })}
                    />
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

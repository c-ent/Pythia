import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskCitation, AskResponse } from '../api/ask'
import { AskScreen } from './AskScreen'
import { answerForCopy, resetAskMemory, sourceCount } from './ask'
import { TRY_ASKING_EXAMPLES } from './home'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const citation = (over: Partial<AskCitation> = {}): AskCitation => ({
  n: 1,
  chunkId: 11,
  documentId: 7,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Dev/Supabase/auth-setup.md',
  title: 'Supabase auth setup',
  headingPath: 'Supabase auth setup > Redirects',
  startLine: 1,
  endLine: 9,
  allowLlm: true,
  snippet: { text: 'Add the callback URL to the redirect allow list', highlights: [[8, 16]] },
  ...over,
})

const CITATIONS = [
  citation(),
  citation({
    n: 2,
    chunkId: 12,
    documentId: 9,
    source: { kind: 'repo', name: 'odsz' },
    path: 'src/lib/auth.ts',
    title: 'auth.ts',
    headingPath: '',
    snippet: { text: 'signInWithMagicLink passes emailRedirectTo', highlights: [] },
  }),
]

const answer = (over: Partial<AskResponse> = {}): AskResponse => ({
  answer: 'The callback URL is missing from the allow list [1]. You already pass emailRedirectTo [2].',
  engine: 'gemini',
  model: 'gemini-2.5-flash',
  fallbacks: [],
  citations: CITATIONS,
  withheld: 0,
  degraded: false,
  ...over,
})

function stubFetch({
  respond = () => json(200, answer()),
  recent = [],
}: { respond?: (body: Record<string, unknown>) => Response; recent?: string[] } = {}) {
  const asks: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/ask') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        asks.push(body)
        return respond(body)
      }
      if (url.startsWith('/api/recent-queries')) {
        return json(200, {
          queries: recent.map((query, i) => ({ id: i + 1, kind: 'ask', query, filters: {}, at: '2026-11-26T01:00:00.000Z' })),
        })
      }
      return json(404, { error: 'not_found' })
    }),
  )
  return asks
}

/** The `[n]` citation marker in the answer (its text is `source n`). */
const markerOrNull = (n: number): HTMLElement | null =>
  screen.queryAllByRole('link').find((link) => link.textContent === `source ${n}`) ?? null
const marker = (n: number): HTMLElement => {
  const link = markerOrNull(n)
  if (link === null) throw new Error(`no marker ${n}`)
  return link
}

function ask(text: string, label = 'Ask a question about your notes and code'): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

describe('AskScreen', () => {
  beforeEach(() => {
    resetAskMemory()
  })

  afterEach(() => {
    resetAskMemory()
  })

  it('offers the example questions until anything was asked', async () => {
    stubFetch()
    render(<AskScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Ask' })).toBeTruthy()
    const examples = screen.getByRole('region', { name: 'Try asking' })
    for (const question of TRY_ASKING_EXAMPLES) expect(within(examples).getByRole('button', { name: question })).toBeTruthy()
  })

  it('offers recent questions from the server, and asks one when clicked', async () => {
    const asks = stubFetch({ recent: ['Which repo uses Docker?'] })
    render(<AskScreen />)
    const recent = await screen.findByRole('region', { name: 'Recent questions' })
    fireEvent.click(within(recent).getByRole('button', { name: 'Which repo uses Docker?' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Which repo uses Docker?' })).toBeTruthy()
    await waitFor(() => expect(asks).toEqual([{ question: 'Which repo uses Docker?' }]))
  })

  it('shows the question, engine, cited answer, engine chain and sources', async () => {
    const asks = stubFetch()
    render(<AskScreen />)
    ask('  Why does my magic link loop? ')

    expect(screen.getByRole('heading', { level: 1, name: 'Why does my magic link loop?' })).toBeTruthy()
    expect(screen.getByText('Writing an answer…')).toBeTruthy()
    expect(await screen.findByText('Answered by Gemini')).toBeTruthy()
    expect(asks).toEqual([{ question: 'Why does my magic link loop?' }])
    expect(screen.getByText('Used 2 sources')).toBeTruthy()
    expect(marker(1)).toBeTruthy()
    expect(marker(2)).toBeTruthy()

    const engines = screen.getByRole('region', { name: 'Answer engine' })
    const steps = within(engines).getAllByRole('listitem')
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual(['step', null, null])
    expect(within(steps[0]!).getByText('Gemini')).toBeTruthy()

    const sources = screen.getByRole('region', { name: 'Sources' })
    expect(within(sources).getByRole('link', { name: 'Supabase auth setup' })).toBeTruthy()
    expect(within(sources).getByRole('link', { name: 'auth.ts' })).toBeTruthy()
    // No kept-away note when nothing was withheld.
    expect(screen.queryByText(/kept from Gemini/)).toBeNull()
  })

  it('sends the source filter with the question', async () => {
    const asks = stubFetch()
    render(<AskScreen />)
    fireEvent.click(within(screen.getByRole('group', { name: 'Sources' })).getByRole('button', { name: 'Repos' }))
    ask('Which repo uses Docker?')
    await screen.findByText('Answered by Gemini')
    expect(asks).toEqual([{ question: 'Which repo uses Docker?', sources: ['repo'] }])
  })

  it('says when matching notes were kept away from Gemini', async () => {
    stubFetch({ respond: () => json(200, answer({ withheld: 1 })) })
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    expect(await screen.findByText('1 local-only match was kept from Gemini.')).toBeTruthy()
  })

  it('swaps the answer for the snippets with Show only snippets', async () => {
    stubFetch()
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    const toggle = await screen.findByRole('button', { name: 'Show only snippets' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(markerOrNull(1)).toBeNull()
    expect(screen.getByText('Showing the matching passages instead of the answer.')).toBeTruthy()
    expect(screen.getByText(/signInWithMagicLink passes emailRedirectTo/)).toBeTruthy()
    // The snippets list replaces the side Sources panel.
    expect(screen.queryByRole('region', { name: 'Sources' })).toBeNull()

    fireEvent.click(toggle)
    expect(marker(1)).toBeTruthy()
  })

  it('copies the answer with its numbered sources', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      stubFetch()
      render(<AskScreen />)
      ask('Why does my magic link loop?')
      fireEvent.click(await screen.findByRole('button', { name: 'Copy answer' }))
      await waitFor(() => expect(screen.getByText('Answer copied')).toBeTruthy())
      expect(writeText).toHaveBeenCalledWith(answerForCopy(answer()))
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('shows the passages when no model answered, without Copy answer', async () => {
    stubFetch({
      respond: () => json(200, answer({ answer: null, engine: 'retrieval', model: null, fallbacks: ['gemini_unconfigured', 'ollama_unconfigured'] })),
    })
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    expect(await screen.findByText('Matching passages')).toBeTruthy()
    expect(screen.getByText('No AI model is set up, so these are the passages that match best.')).toBeTruthy()
    expect(screen.getByText(/URL to the redirect allow list/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy answer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show only snippets' })).toBeNull()
    const steps = within(screen.getByRole('region', { name: 'Answer engine' })).getAllByRole('listitem')
    expect(steps.map((step) => step.getAttribute('aria-current'))).toEqual([null, null, 'step'])
  })

  it('says when nothing matches', async () => {
    stubFetch({ respond: () => json(200, answer({ answer: null, engine: 'retrieval', model: null, citations: [], fallbacks: ['no_results'] })) })
    render(<AskScreen />)
    ask('Something unknown')
    expect(await screen.findByText(/Nothing in your notes, repos or Keep matches this question/)).toBeTruthy()
  })

  it('shows an error with Retry that asks again', async () => {
    let calls = 0
    const asks = stubFetch({
      respond: () => {
        calls += 1
        return calls === 1 ? json(500, { error: 'internal' }) : json(200, answer())
      },
    })
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    expect((await screen.findByRole('alert')).textContent).toContain('The answer failed. Try asking again.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Answered by Gemini')).toBeTruthy()
    expect(asks).toHaveLength(2)
  })

  it('asks a follow-up from the box under the answer', async () => {
    const asks = stubFetch()
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    await screen.findByText('Answered by Gemini')
    ask('What else uses Supabase auth?', 'Ask a follow-up question')
    expect(await screen.findByRole('heading', { level: 1, name: 'What else uses Supabase auth?' })).toBeTruthy()
    await waitFor(() => expect(asks).toHaveLength(2))
    expect(asks[1]).toEqual({
      question: 'What else uses Supabase auth?',
      history: [
        {
          question: 'Why does my magic link loop?',
          answer: 'The callback URL is missing from the allow list [1]. You already pass emailRedirectTo [2].',
        },
      ],
    })
  })

  it('streams SSE tokens into the answer as they arrive', async () => {
    const sse = [
      `event: meta\ndata: ${JSON.stringify({ engine: 'gemini', model: 'gemini-2.5-flash', fallbacks: [], citations: CITATIONS, withheld: 0, degraded: false })}`,
      '',
      `event: token\ndata: ${JSON.stringify({ text: 'Streaming ' })}`,
      '',
      `event: token\ndata: ${JSON.stringify({ text: 'answer [1].' })}`,
      '',
      `event: done\ndata: ${JSON.stringify({ answer: 'Streaming answer [1].' })}`,
      '',
    ].join('\n')
    stubFetch({
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sse))
              controller.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
    })
    render(<AskScreen />)
    ask('Stream test?')
    expect(await screen.findByText('Answered by Gemini')).toBeTruthy()
    expect(screen.getByText(/Streaming answer/)).toBeTruthy()
  })

  it('goes back to an empty box with New question', async () => {
    stubFetch()
    render(<AskScreen />)
    ask('Why does my magic link loop?')
    await screen.findByText('Answered by Gemini')
    fireEvent.click(screen.getByRole('button', { name: 'New question' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Ask' })).toBeTruthy()
    expect((screen.getByLabelText('Ask a question about your notes and code') as HTMLInputElement).value).toBe('')
  })

  it('keeps the answer after leaving the page and coming back', async () => {
    const asks = stubFetch()
    const first = render(<AskScreen />)
    ask('Why does my magic link loop?')
    await screen.findByText('Answered by Gemini')
    first.unmount()

    render(<AskScreen />)
    expect(screen.getByRole('heading', { level: 1, name: 'Why does my magic link loop?' })).toBeTruthy()
    expect(screen.getByText('Answered by Gemini')).toBeTruthy()
    expect(asks).toHaveLength(1)
  })

  it('cannot ask while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    try {
      stubFetch()
      render(<AskScreen />)
      expect(screen.getByText('You’re offline. Ask needs a connection.')).toBeTruthy()
      fireEvent.change(screen.getByLabelText('Ask a question about your notes and code'), { target: { value: 'Hi' } })
      expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('Ask helpers', () => {
  it('counts sources', () => {
    expect(sourceCount(1)).toBe('Used 1 source')
    expect(sourceCount(3)).toBe('Used 3 sources')
  })

  it('copies the answer text with the numbered sources after it', () => {
    expect(answerForCopy(answer())).toBe(
      [
        'The callback URL is missing from the allow list [1]. You already pass emailRedirectTo [2].',
        '',
        'Sources',
        '[1] Supabase auth setup (Dev/Supabase/auth-setup.md)',
        '[2] auth.ts (src/lib/auth.ts)',
      ].join('\n'),
    )
    expect(answerForCopy({ answer: 'Just this.', citations: [] })).toBe('Just this.')
  })
})

import { describe, expect, it } from 'vitest'
import type { AskContextLoader, ChunkText, ChunkTextLoader, RecentCatalogEntry, RepoCatalogEntry } from '../db/searchStore.js'
import type { SearchResult, SearchService } from '../search/searchService.js'
import { buildPrompt, createAskService, RETRIEVAL_PASSAGES, SYSTEM_PROMPT } from './askService.js'
import { LlmError, type ChatModel, type ChatPrompt } from './llm.js'

const PRIVATE_TEXT = 'Private salary figure: 123456 per year.'
const PUBLIC_TEXT = 'The goal of Pythia is cited answers across notes.'

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  chunkId: 1,
  documentId: 10,
  source: { kind: 'obsidian', name: 'vault' },
  path: 'Projects/Pythia.md',
  title: 'Pythia',
  headingPath: 'Pythia > Goals',
  startLine: 1,
  endLine: 3,
  allowLlm: true,
  score: 0.03,
  ftsRank: 1,
  vectorRank: 1,
  snippet: { text: 'The goal of Pythia', highlights: [[4, 8]] },
  ...over,
})

const privateHit = result({
  chunkId: 2,
  documentId: 20,
  path: 'Private/Money.md',
  title: 'Money',
  headingPath: 'Money',
  allowLlm: false,
  snippet: { text: 'Private salary figure', highlights: [] },
})
const publicHit = result()

function fakeSearch(results: SearchResult[], degraded = false) {
  const calls: Parameters<SearchService['search']>[0][] = []
  const search: SearchService = {
    async search(request) {
      calls.push(request)
      return { results, degraded }
    },
    async getDocument() {
      return null
    },
    async findDocument() {
      return null
    },
    async recent() {
      return []
    },
  }
  return { search, calls }
}

function loader(texts: Record<number, ChunkText>): ChunkTextLoader {
  return {
    async chunkTexts(ids) {
      return new Map(ids.flatMap((id) => (texts[id] === undefined ? [] : [[id, texts[id]] as const])))
    },
  }
}

const defaultTexts = {
  1: { content: PUBLIC_TEXT, allowLlm: true },
  2: { content: PRIVATE_TEXT, allowLlm: false },
}

function fakeModel(engine: 'gemini' | 'ollama', answer: string | Error = 'Answer [1].') {
  const prompts: ChatPrompt[] = []
  const model: ChatModel = {
    engine,
    model: engine === 'gemini' ? 'gemini-test' : 'local-test',
    async generate(prompt) {
      prompts.push(prompt)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { model, prompts }
}

const quiet = () => {}

describe('ask service', () => {
  it('answers with Gemini using only allowed passages; private text never reaches it', async () => {
    const { search } = fakeSearch([privateHit, publicHit])
    const gemini = fakeModel('gemini')
    const local = fakeModel('ollama')
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: gemini.model, local: local.model, log: quiet })

    const response = await ask.ask({ question: 'What is my salary and the goal?' })

    expect(response).toMatchObject({ engine: 'gemini', model: 'gemini-test', answer: 'Answer [1].', fallbacks: [], withheld: 1 })
    expect(response.citations.map((c) => [c.n, c.path])).toEqual([[1, 'Projects/Pythia.md']])
    expect(gemini.prompts).toHaveLength(1)
    const sent = JSON.stringify(gemini.prompts)
    expect(sent).toContain(PUBLIC_TEXT)
    expect(sent).not.toContain(PRIVATE_TEXT)
    expect(sent).not.toContain('Private/Money.md')
    expect(local.prompts).toHaveLength(0)
  })

  it('sends a Keep note to Gemini but never an llm-excluded Obsidian note', async () => {
    const KEEP_TEXT = 'Keep list: renew passport before March.'
    const keepHit = result({
      chunkId: 4,
      documentId: 40,
      source: { kind: 'keep', name: 'keep' },
      path: 'Keep/Passport',
      title: 'Passport',
      headingPath: 'Passport',
      allowLlm: true,
      snippet: { text: 'renew passport', highlights: [] },
    })
    // An Obsidian note kept away by `llm: false` or the Settings exclusion list.
    const excludedHit = result({ ...privateHit, chunkId: 5, path: 'Journal/Health.md', title: 'Health' })
    const { search } = fakeSearch([excludedHit, keepHit])
    const gemini = fakeModel('gemini')
    const ask = createAskService({
      search,
      chunks: loader({ 4: { content: KEEP_TEXT, allowLlm: true }, 5: { content: PRIVATE_TEXT, allowLlm: false } }),
      gemini: gemini.model,
      local: null,
      log: quiet,
    })

    const response = await ask.ask({ question: 'When do I renew my passport?' })

    expect(response).toMatchObject({ engine: 'gemini', fallbacks: [], withheld: 1 })
    expect(response.citations.map((c) => [c.n, c.path])).toEqual([[1, 'Keep/Passport']])
    const sent = JSON.stringify(gemini.prompts)
    expect(sent).toContain(KEEP_TEXT)
    expect(sent).not.toContain(PRIVATE_TEXT)
    expect(sent).not.toContain('Journal/Health.md')
  })

  it('skips Gemini when every match is private and answers locally with all passages', async () => {
    const { search } = fakeSearch([privateHit])
    const gemini = fakeModel('gemini')
    const local = fakeModel('ollama')
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: gemini.model, local: local.model, log: quiet })

    const response = await ask.ask({ question: 'salary?' })

    expect(gemini.prompts).toHaveLength(0)
    expect(response).toMatchObject({ engine: 'ollama', model: 'local-test', fallbacks: ['all_private'] })
    expect(JSON.stringify(local.prompts)).toContain(PRIVATE_TEXT)
  })

  it('never sends a chunk whose document turned private after the search', async () => {
    // The search result still says allowLlm = true, but the fresh load says false.
    const { search } = fakeSearch([result({ chunkId: 3 })])
    const gemini = fakeModel('gemini')
    const ask = createAskService({
      search,
      chunks: loader({ 3: { content: PRIVATE_TEXT, allowLlm: false } }),
      gemini: gemini.model,
      local: null,
      log: quiet,
    })

    const response = await ask.ask({ question: 'q' })

    expect(gemini.prompts).toHaveLength(0)
    expect(response.engine).toBe('retrieval')
    expect(response.fallbacks).toEqual(['all_private', 'ollama_unconfigured'])
  })

  it('never sends a chunk that could not be loaded', async () => {
    const { search } = fakeSearch([result({ chunkId: 99 })])
    const gemini = fakeModel('gemini')
    const ask = createAskService({ search, chunks: loader({}), gemini: gemini.model, local: null, log: quiet })
    await ask.ask({ question: 'q' })
    expect(gemini.prompts).toHaveLength(0)
  })

  it('looks the Gemini model up on every question, so a key saved or removed in Settings applies at once', async () => {
    const { search } = fakeSearch([publicHit])
    const gemini = fakeModel('gemini')
    let current: ChatModel | null = null
    let lookups = 0
    const ask = createAskService({
      search,
      chunks: loader(defaultTexts),
      gemini: async () => {
        lookups++
        return current
      },
      local: null,
      log: quiet,
    })
    expect(await ask.ask({ question: 'q' })).toMatchObject({ engine: 'retrieval', fallbacks: ['gemini_unconfigured', 'ollama_unconfigured'] })
    current = gemini.model
    expect(await ask.ask({ question: 'q' })).toMatchObject({ engine: 'gemini' })
    current = null
    expect(await ask.ask({ question: 'q' })).toMatchObject({ engine: 'retrieval' })
    expect(lookups).toBe(3)
    expect(gemini.prompts).toHaveLength(1)
  })

  it('skips Gemini when the key lookup fails, logging no key', async () => {
    const { search } = fakeSearch([publicHit])
    const local = fakeModel('ollama')
    const logs: string[] = []
    const ask = createAskService({
      search,
      chunks: loader(defaultTexts),
      gemini: async () => {
        throw new Error('database down')
      },
      local: local.model,
      log: (message) => logs.push(message),
    })
    expect(await ask.ask({ question: 'q' })).toMatchObject({ engine: 'ollama', fallbacks: ['gemini_unconfigured'] })
    expect(logs).toEqual(['gemini key lookup failed (Error); skipping Gemini'])
  })

  it('falls back cleanly when GEMINI_API_KEY is unset', async () => {
    const { search } = fakeSearch([publicHit])
    const local = fakeModel('ollama')
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: null, local: local.model, log: quiet })
    const response = await ask.ask({ question: 'goal?' })
    expect(response).toMatchObject({ engine: 'ollama', fallbacks: ['gemini_unconfigured'] })
  })

  it('returns retrieval-only passages when no model is configured', async () => {
    const hits = [1, 2, 3, 4, 5].map((n) => result({ chunkId: n, path: `n${n}.md` }))
    const { search } = fakeSearch(hits)
    const texts = Object.fromEntries(hits.map((h) => [h.chunkId, { content: `text ${h.chunkId}`, allowLlm: true }]))
    const ask = createAskService({ search, chunks: loader(texts), gemini: null, local: null, log: quiet })

    const response = await ask.ask({ question: 'q' })

    expect(response).toMatchObject({
      answer: null,
      engine: 'retrieval',
      model: null,
      fallbacks: ['gemini_unconfigured', 'ollama_unconfigured'],
    })
    expect(response.citations).toHaveLength(RETRIEVAL_PASSAGES)
    expect(response.citations[0]).toMatchObject({ n: 1, path: 'n1.md', snippet: hits[0]?.snippet })
  })

  it('goes Gemini → local → retrieval as each one fails, logging no question text', async () => {
    const { search } = fakeSearch([publicHit])
    const logs: string[] = []
    const gemini = fakeModel('gemini', new LlmError('Gemini returned HTTP 429', { status: 429, retryable: true }))
    const local = fakeModel('ollama', new LlmError('Ollama chat request failed: network error'))
    const ask = createAskService({
      search,
      chunks: loader(defaultTexts),
      gemini: gemini.model,
      local: local.model,
      log: (m) => logs.push(m),
    })

    const response = await ask.ask({ question: 'my secret question' })

    expect(response).toMatchObject({ engine: 'retrieval', fallbacks: ['gemini_failed', 'ollama_failed'] })
    expect(gemini.prompts).toHaveLength(1)
    expect(local.prompts).toHaveLength(1)
    expect(logs).toHaveLength(2)
    expect(logs.join('\n')).toContain('LlmError 429')
    expect(logs.join('\n')).not.toContain('secret')
  })

  it('answers locally after a Gemini failure', async () => {
    const { search } = fakeSearch([publicHit])
    const gemini = fakeModel('gemini', new LlmError('Gemini request failed: timed out'))
    const local = fakeModel('ollama', 'Local answer [1].')
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: gemini.model, local: local.model, log: quiet })
    const response = await ask.ask({ question: 'q' })
    expect(response).toMatchObject({ engine: 'ollama', answer: 'Local answer [1].', fallbacks: ['gemini_failed'] })
  })

  it('handles zero search results without calling any model', async () => {
    const { search } = fakeSearch([])
    const gemini = fakeModel('gemini')
    const local = fakeModel('ollama')
    const ask = createAskService({ search, chunks: loader({}), gemini: gemini.model, local: local.model, log: quiet })
    const response = await ask.ask({ question: 'nothing matches' })
    expect(response).toEqual({
      answer: null,
      engine: 'retrieval',
      model: null,
      fallbacks: ['no_results'],
      citations: [],
      withheld: 0,
      degraded: false,
    })
    expect(gemini.prompts).toHaveLength(0)
    expect(local.prompts).toHaveLength(0)
  })

  it('passes filters and a clamped candidate limit to search, and reports degraded search', async () => {
    const { search, calls } = fakeSearch([publicHit], true)
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: null, local: null, log: quiet })
    const response = await ask.ask({ question: 'q', sources: ['repo'], repo: 'pythia', limit: 50 })
    expect(calls[0]).toEqual({ query: 'q', sources: ['repo'], repo: 'pythia', limit: 30 })
    expect(response.degraded).toBe(true)
    await ask.ask({ question: 'q' })
    expect(calls[1]?.limit).toBe(18)
  })

  it('diversifies search hits across documents before taking repeated chunks from the same doc', async () => {
    const dupA1 = result({ chunkId: 11, documentId: 100, path: 'Career.md', title: 'Career' })
    const dupA2 = result({ chunkId: 12, documentId: 100, path: 'Career.md', title: 'Career' })
    const docB = result({ chunkId: 13, documentId: 200, path: 'Stack.md', title: 'Stack' })
    const { search } = fakeSearch([dupA1, dupA2, docB])
    const gemini = fakeModel('gemini', 'See [1] and [2].')
    const ask = createAskService({
      search,
      chunks: loader({
        11: { content: 'Career part 1', allowLlm: true },
        12: { content: 'Career part 2', allowLlm: true },
        13: { content: 'Stack note', allowLlm: true },
      }),
      gemini: gemini.model,
      local: null,
      log: quiet,
    })

    const response = await ask.ask({ question: 'what stack?', limit: 2 })
    expect(response.citations.map((c) => c.path)).toEqual(['Career.md', 'Stack.md'])
  })

  it('provides a privacy-filtered catalog and newest repo summaries for temporal/project questions', async () => {
    const repoPublic: RepoCatalogEntry = {
      chunkId: 50,
      documentId: 500,
      name: 'nova',
      title: 'nova overview',
      headingPath: 'SUMMARY > nova',
      allowLlm: true,
      firstCommitAt: new Date('2026-11-20T00:00:00Z'),
      lastCommitAt: new Date('2026-11-28T09:00:00Z'),
      updatedAt: new Date('2026-11-28T09:05:00Z'),
      languages: 'typescript (12)',
      summaryText: '',
    } as RepoCatalogEntry & { summaryText?: string }
    const repoPrivate: RepoCatalogEntry = {
      chunkId: 51,
      documentId: 501,
      name: 'secret-repo',
      title: 'secret-repo overview',
      headingPath: 'SUMMARY > secret-repo',
      allowLlm: false,
      firstCommitAt: new Date('2026-11-27T00:00:00Z'),
      lastCommitAt: new Date('2026-11-28T10:00:00Z'),
      updatedAt: new Date('2026-11-28T10:05:00Z'),
      languages: 'python (5)',
    }
    const recentPublic: RecentCatalogEntry = {
      chunkId: 60,
      documentId: 600,
      source: { kind: 'obsidian', name: 'vault' },
      path: 'Notes/Plan.md',
      title: 'Plan',
      headingPath: 'Plan',
      allowLlm: true,
      mtime: new Date('2026-11-27T00:00:00Z'),
      updatedAt: new Date('2026-11-27T00:00:00Z'),
    }
    const recentPrivate: RecentCatalogEntry = {
      chunkId: 61,
      documentId: 601,
      source: { kind: 'obsidian', name: 'vault' },
      path: 'Private/SecretPlan.md',
      title: 'SecretPlan',
      headingPath: 'SecretPlan',
      allowLlm: false,
      mtime: new Date('2026-11-28T00:00:00Z'),
      updatedAt: new Date('2026-11-28T00:00:00Z'),
    }
    const context: AskContextLoader = {
      async repoCatalog() {
        return [repoPrivate, repoPublic]
      },
      async recentDocuments() {
        return [recentPrivate, recentPublic]
      },
    }
    const { search } = fakeSearch([publicHit])
    const gemini = fakeModel('gemini', 'Your latest project is nova [1].')
    const ask = createAskService({
      search,
      chunks: loader({
        1: { content: PUBLIC_TEXT, allowLlm: true },
        50: { content: 'Repository: nova\nFirst commit: 2026-11-20T00:00:00.000Z\nLatest commit: 2026-11-28T09:00:00.000Z\n\nDependencies:\npackage.json dependencies: next, react', allowLlm: true },
        51: { content: 'TOP SECRET REPO', allowLlm: false },
        60: { content: 'Plan text', allowLlm: true },
        61: { content: 'TOP SECRET NOTE', allowLlm: false },
      }),
      context,
      gemini: gemini.model,
      local: null,
      now: () => new Date('2026-11-28T12:00:00Z'),
      log: quiet,
    })

    const response = await ask.ask({ question: 'whats my latest project tech stack?' })
    expect(response.engine).toBe('gemini')
    expect(response.citations[0]?.source.name).toBe('nova')
    const promptSent = JSON.stringify(gemini.prompts[0])
    expect(promptSent).toContain('Today: 2026-11-28')
    expect(promptSent).toContain('nova | first 2026-11-20 | latest 2026-11-28')
    expect(promptSent).toContain('next, react')
    expect(promptSent).not.toContain('secret-repo')
    expect(promptSent).not.toContain('TOP SECRET')
    expect(promptSent).not.toContain('SecretPlan')
  })
})

describe('buildPrompt', () => {
  it('numbers passages with their path and heading and fences them as data', () => {
    const prompt = buildPrompt('What is the goal?', [
      { result: publicHit, text: PUBLIC_TEXT, cloudAllowed: true },
      { result: result({ path: 'b.md', headingPath: '' }), text: 'Second.', cloudAllowed: true },
    ])
    expect(prompt.system).toBe(SYSTEM_PROMPT)
    expect(prompt.user).toContain(`[1] Projects/Pythia.md — Pythia > Goals\n${PUBLIC_TEXT}`)
    expect(prompt.user).toContain('[2] b.md\nSecond.')
    expect(prompt.user.indexOf('<passages>')).toBe(0)
    expect(prompt.user.endsWith('Question: What is the goal?')).toBe(true)
  })

  it('caps very long passages', () => {
    const prompt = buildPrompt('q', [{ result: publicHit, text: 'x'.repeat(10_000), cloudAllowed: true }])
    expect(prompt.user.length).toBeLessThan(5_000)
  })
})

describe('askStream and follow-up history', () => {
  it('streams meta on the first token and falls back cleanly before tokens start', async () => {
    const { search } = fakeSearch([publicHit])
    const gemini: ChatModel = {
      engine: 'gemini',
      model: 'gemini-test',
      async generate() {
        throw new LlmError('rate limit', { status: 429 })
      },
      async generateStream() {
        throw new LlmError('rate limit', { status: 429 })
      },
    }
    const local: ChatModel = {
      engine: 'ollama',
      model: 'local-test',
      async generate() {
        return 'Part 1 Part 2'
      },
      async generateStream(_prompt, onToken) {
        onToken('Part 1 ')
        onToken('Part 2')
        return 'Part 1 Part 2'
      },
    }
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini, local, log: quiet })
    const events: unknown[] = []
    const response = await ask.askStream!({ question: 'Goal?' }, (event) => events.push(event))

    expect(response).toMatchObject({ engine: 'ollama', answer: 'Part 1 Part 2', fallbacks: ['gemini_failed'] })
    expect(events).toEqual([
      expect.objectContaining({ type: 'meta', engine: 'ollama', fallbacks: ['gemini_failed'] }),
      { type: 'token', text: 'Part 1 ' },
      { type: 'token', text: 'Part 2' },
      { type: 'done', answer: 'Part 1 Part 2' },
    ])
  })

  it('passes follow-up history and still enforces allow_llm on retrieved passages', async () => {
    const { search, calls } = fakeSearch([privateHit])
    const gemini = fakeModel('gemini')
    const local = fakeModel('ollama', 'Local follow-up.')
    const ask = createAskService({ search, chunks: loader(defaultTexts), gemini: gemini.model, local: local.model, log: quiet })

    const response = await ask.ask({
      question: 'which file had that?',
      history: [{ question: 'what is my salary?', answer: '123456' }],
    })

    expect(response.engine).toBe('ollama')
    expect(response.fallbacks).toEqual(['all_private'])
    expect(gemini.prompts).toHaveLength(0)
    expect(local.prompts[0]?.history).toEqual([{ question: 'what is my salary?', answer: '123456' }])
    expect(calls.map((c) => c.query)).toEqual(['which file had that?', 'what is my salary?'])
  })
})

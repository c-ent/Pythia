import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'
import { createPgIndexStore, ensureSource } from './indexStore.js'
import { createPgChunkTextLoader, createPgSearchStore } from './searchStore.js'
import { createAskService } from '../ask/askService.js'
import type { ChatModel } from '../ask/llm.js'
import { EMBED_DIMENSIONS, OllamaError, type Embedder } from '../embed/ollama.js'
import { createVaultIndexer } from '../ingest/vaultIndexer.js'
import { createSearchService, type SearchService } from '../search/searchService.js'

// T7 verify against real Postgres: a fixture vault indexed by the T6 indexer,
// then hybrid search through the service. The fake embedder puts texts about
// the same topic on the same axis, so synonyms that full-text search cannot
// match still meet in vector search. Opt-in with PYTHIA_DB_TESTS=1.
const TOPICS: ReadonlyArray<readonly string[]> = [
  ['cat', 'cats', 'feline', 'kitten'],
  ['rocket', 'launch', 'orbit', 'spacecraft'],
  ['sourdough', 'bread', 'baking', 'loaf'],
  ['budget', 'invoice', 'expenses', 'money'],
]

function topicVector(text: string): number[] {
  const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? [])
  const vector = Array.from({ length: EMBED_DIMENSIONS }, () => 0.001)
  TOPICS.forEach((topic, axis) => {
    if (topic.some((word) => words.has(word))) vector[axis] = 1
  })
  return vector
}

describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('hybrid search against Postgres', () => {
  const dbName = `pythia_search_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let root: string
  let ollamaDown = false
  let search: SearchService

  const embedder: Embedder = {
    model: 'nomic-embed-text',
    dimensions: EMBED_DIMENSIONS,
    async embedDocuments(texts) {
      return texts.map(topicVector)
    },
    async embedQuery(text) {
      if (ollamaDown) throw new OllamaError('Ollama request failed', { retryable: true })
      return topicVector(text)
    },
  }

  const put = async (relPath: string, text: string): Promise<void> => {
    const abs = path.join(root, ...relPath.split('/'))
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, text)
  }

  const addDoc = async (sourceId: number, docPath: string, content: string, model = embedder.model) => {
    await createPgIndexStore(pool).replaceDocument(
      sourceId,
      { path: docPath, title: docPath, language: null, contentHash: docPath, allowLlm: true, mtime: null },
      [{ ordinal: 0, headingPath: docPath, startLine: 1, endLine: 1, content, embedding: topicVector(content) }],
      model,
    )
  }

  const paths = async (request: Parameters<SearchService['search']>[0]) =>
    (await search.search(request)).results.map((result) => result.path)

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    // DROP DATABASE ... WITH (FORCE) in afterAll can kill a client that is
    // still closing (57P01); without a handler that is an unhandled error.
    pool.on('error', () => {})
    // Same for errors raised on an individual checked-out client.
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)

    root = await mkdtemp(path.join(tmpdir(), 'pythia-search-db-'))
    await put('Pets/Cats.md', '# Cats\n\nMy cats sleep on the radiator every afternoon.')
    await put('Space/Launch.md', '# Launch notes\n\nThe rocket reached orbit after a long countdown.')
    await put('Kitchen/Bread.md', '# Sourdough\n\nFeed the starter, then bake the loaf at 230 degrees.')
    await put('Private/Money.md', '# Budget\n\nRent and expenses for the month.')
    const vault = await ensureSource(pool, 'obsidian', 'vault', root)
    const indexer = createVaultIndexer({
      root,
      sourceId: vault.id,
      store: createPgIndexStore(pool),
      embedder,
      exclusions: async () => [{ kind: 'folder', path: 'Private' }],
    })
    expect((await indexer.fullScan()).failed).toEqual([])

    // Enough repo chunks about rockets to fill every one of the 50 candidate
    // slots, so a filter applied after LIMIT would leave the vault note out.
    const repo = await ensureSource(pool, 'repo', 'launcher', '/repos/launcher')
    for (let i = 0; i < 60; i++) await addDoc(repo.id, `src/rocket${i}.ts`, `// rocket launch step ${i}`)
    const other = await ensureSource(pool, 'repo', 'kitchen-app', '/repos/kitchen-app')
    await addDoc(other.id, 'README.md', 'Sourdough bread timer app.')

    const work = await pool.query<{ id: string }>(
      `INSERT INTO sources (kind, name, root_path) VALUES ('work', 'employer', '/work') RETURNING id`,
    )
    await addDoc(Number(work.rows[0]?.id), 'work/cats.md', 'Employer cats memo about the rocket launch.')
    const disabled = await ensureSource(pool, 'keep', 'keep', '/keep')
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [disabled.id])
    await addDoc(disabled.id, 'keep/cats.md', 'Disabled cats note.')
    const keep = await ensureSource(pool, 'chat', 'chat', '/chat')
    // Same topic, older embedding model: its vector must not be compared.
    await addDoc(keep.id, 'chat/kitten.md', 'Kitten adoption chat log.', 'old-model')

    search = createSearchService({ store: createPgSearchStore(pool), embedder, log: () => {} })
    // Migrations plus ~65 indexed documents: under the full parallel suite this
    // takes longer than the 10 s default, though it is well under it alone.
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('ranks a note matched by both full text and vectors first, with a highlighted snippet', async () => {
    const { results, degraded } = await search.search({ query: 'cats radiator', sources: ['obsidian'] })
    expect(degraded).toBe(false)
    const top = results[0]
    expect(top).toMatchObject({ path: 'Pets/Cats.md', headingPath: 'Cats > Cats', ftsRank: 1, vectorRank: 1 })
    expect(top?.score).toBeCloseTo(2 / 61, 10)
    const marked = top?.snippet.highlights.map(([start, end]) => top.snippet.text.slice(start, end))
    expect(marked).toEqual(expect.arrayContaining(['cats', 'radiator']))
  })

  it('finds a note by meaning when no word matches', async () => {
    const { results } = await search.search({ query: 'feline', sources: ['obsidian'] })
    expect(results[0]).toMatchObject({ path: 'Pets/Cats.md', ftsRank: null, vectorRank: 1 })
  })

  it('finds a note by an exact word with no vector match', async () => {
    ollamaDown = false
    const { results } = await search.search({ query: 'radiator countdown', sources: ['obsidian'], limit: 5 })
    expect(results.map((r) => r.path)).toEqual(expect.arrayContaining(['Pets/Cats.md', 'Space/Launch.md']))
  })

  it('keeps a filtered source in the top results even when other sources fill 50 candidates', async () => {
    expect(await paths({ query: 'rocket launch', sources: ['obsidian'], limit: 5 })).toEqual(
      expect.arrayContaining(['Space/Launch.md']),
    )
    const unfiltered = await paths({ query: 'rocket launch', limit: 50 })
    expect(unfiltered.filter((p) => p.startsWith('src/')).length).toBeGreaterThan(40)
  })

  it('returns only the named repo', async () => {
    const found = await paths({ query: 'sourdough bread', repo: 'kitchen-app' })
    expect(found).toEqual(['README.md'])
    // Vector search always returns the nearest chunks, so the launcher repo
    // still answers; none of its results may come from another source.
    const launcher = (await search.search({ query: 'sourdough bread', repo: 'launcher', limit: 50 })).results
    expect(launcher.length).toBeGreaterThan(0)
    expect(launcher.every((r) => r.source.kind === 'repo' && r.source.name === 'launcher')).toBe(true)
    expect(launcher.every((r) => r.ftsRank === null)).toBe(true)
  })

  it('never returns work, disabled, or other-model vectors', async () => {
    const found = await paths({ query: 'cats kitten feline', limit: 50 })
    expect(found).not.toContain('work/cats.md')
    expect(found).not.toContain('keep/cats.md')
    const chat = (await search.search({ query: 'feline', sources: ['chat'] })).results
    expect(chat).toEqual([])
    // Full text still reaches the chat chunk; only its vector is skipped.
    expect((await search.search({ query: 'kitten adoption', sources: ['chat'] })).results[0]?.vectorRank).toBeNull()
  })

  it('marks allow_llm from the excluded folder on results', async () => {
    const { results } = await search.search({ query: 'budget expenses', sources: ['obsidian'] })
    expect(results[0]).toMatchObject({ path: 'Private/Money.md', allowLlm: false })
  })

  it('degrades to full text only when Ollama is down', async () => {
    ollamaDown = true
    try {
      const response = await search.search({ query: 'radiator', sources: ['obsidian'] })
      expect(response.degraded).toBe(true)
      expect(response.results[0]).toMatchObject({ path: 'Pets/Cats.md', vectorRank: null })
      expect((await search.search({ query: 'feline', sources: ['obsidian'] })).results).toEqual([])
    } finally {
      ollamaDown = false
    }
  })

  it('handles queries that are only stop words or punctuation', async () => {
    const response = await search.search({ query: 'the !!! "and"', sources: ['obsidian'], limit: 3 })
    expect(response.results.length).toBeLessThanOrEqual(3)
    expect(response.results.every((r) => r.ftsRank === null)).toBe(true)
  })

  it('gets documents by id and by source and path, and lists recent ones', async () => {
    const byPath = await search.findDocument('obsidian', null, 'Pets/Cats.md')
    expect(byPath?.content).toContain('radiator')
    expect((await search.getDocument(byPath?.id ?? 0))?.path).toBe('Pets/Cats.md')
    expect(await search.findDocument('obsidian', null, 'work/cats.md')).toBeNull()
    expect(await search.findDocument('repo', 'kitchen-app', 'README.md')).toMatchObject({ source: { name: 'kitchen-app' } })

    const recent = await search.recent({ days: 1, source: 'obsidian', limit: 10 })
    expect(recent.map((doc) => doc.path).sort()).toEqual([
      'Kitchen/Bread.md',
      'Pets/Cats.md',
      'Private/Money.md',
      'Space/Launch.md',
    ])
    const everything = await search.recent({ days: 1, limit: 200 })
    expect(everything.some((doc) => doc.path.startsWith('work/') || doc.path.startsWith('keep/'))).toBe(false)
  })

  it('loads chunk text with allow_llm, leaving out work, disabled and missing chunks', async () => {
    const { rows } = await pool.query<{ id: string; path: string }>(
      `SELECT c.id, d.path FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.path IN ('Pets/Cats.md', 'Private/Money.md', 'work/cats.md', 'keep/cats.md')`,
    )
    const idOf = (p: string) => Number(rows.find((row) => row.path === p)?.id)
    const texts = await createPgChunkTextLoader(pool).chunkTexts([
      idOf('Pets/Cats.md'),
      idOf('Private/Money.md'),
      idOf('work/cats.md'),
      idOf('keep/cats.md'),
      999_999_999,
    ])
    expect(texts.get(idOf('Pets/Cats.md'))).toMatchObject({ allowLlm: true })
    expect(texts.get(idOf('Pets/Cats.md'))?.content).toContain('radiator')
    expect(texts.get(idOf('Private/Money.md'))).toMatchObject({ allowLlm: false })
    expect(texts.size).toBe(2)
    expect((await createPgChunkTextLoader(pool).chunkTexts([])).size).toBe(0)
  })

  it('never puts a Private/ note into a Gemini prompt (R8, real index)', async () => {
    const prompts: string[] = []
    const gemini: ChatModel = {
      engine: 'gemini',
      model: 'gemini-test',
      async generate(prompt) {
        prompts.push(JSON.stringify(prompt))
        return 'Answer [1].'
      },
    }
    const ask = createAskService({ search, chunks: createPgChunkTextLoader(pool), gemini, local: null, log: () => {} })

    // The private budget note is the best match; the bread note also matches.
    const mixed = await ask.ask({ question: 'budget expenses bread', sources: ['obsidian'] })
    expect(mixed.engine).toBe('gemini')
    expect(mixed.withheld).toBeGreaterThan(0)
    expect(mixed.citations.every((c) => c.allowLlm)).toBe(true)

    // Only the private note matches (full text only, so vector search cannot
    // pull in the other notes): Gemini is skipped.
    ollamaDown = true
    let onlyPrivate
    try {
      onlyPrivate = await ask.ask({ question: 'rent', sources: ['obsidian'] })
    } finally {
      ollamaDown = false
    }
    expect(onlyPrivate.citations.map((c) => c.path)).toEqual(['Private/Money.md'])
    expect(onlyPrivate).toMatchObject({ engine: 'retrieval', fallbacks: ['all_private', 'ollama_unconfigured'] })

    expect(prompts.length).toBe(1)
    expect(prompts.join('\n')).not.toContain('Rent and expenses')
    expect(prompts.join('\n')).not.toContain('Private/Money.md')
  })
})

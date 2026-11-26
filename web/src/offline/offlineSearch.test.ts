import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { OfflineDb, SYNC_STATE_KEY, type CachedDocument } from './db'
import { buildIndex, makeSnippet, searchIndex, searchOffline, tokenize } from './offlineSearch'

let nextId = 1
const doc = (over: Partial<CachedDocument>): CachedDocument => ({
  id: nextId++,
  sourceKind: 'obsidian',
  sourceName: 'vault',
  path: 'note.md',
  title: 'Note',
  language: null,
  allowLlm: true,
  mtime: null,
  updatedAt: '2026-11-26T00:00:00.000Z',
  content: '',
  truncated: false,
  ...over,
})

const titles = (results: { title: string }[]) => results.map((result) => result.title)

describe('tokenize', () => {
  it('lower-cases, drops accents and one-letter words', () => {
    expect(tokenize('Crème Brûlée, a recipe: 2 eggs & 250g sugar')).toEqual([
      'creme',
      'brulee',
      'recipe',
      'eggs',
      '250g',
      'sugar',
    ])
  })
})

describe('searchIndex', () => {
  const docs = [
    doc({ title: 'Sourdough starter', path: 'Kitchen/Sourdough starter.md', content: 'Feed the starter with flour and water.' }),
    doc({ title: 'Shopping', path: 'Keep/Shopping', sourceKind: 'keep', sourceName: 'keep', content: 'flour, eggs, milk', allowLlm: false }),
    doc({ title: 'Travel', path: 'Trips/Travel.md', content: 'Pack the passport. Water bottle.' }),
    doc({ title: 'auth.ts', path: 'src/auth.ts', sourceKind: 'repo', sourceName: 'kitchen-app', content: 'export function login() {}' }),
  ]
  const index = buildIndex(docs)

  it('ranks title matches above body matches', () => {
    expect(titles(searchIndex(index, { query: 'sourdough' }))).toEqual(['Sourdough starter'])
    const small = buildIndex([
      doc({ title: 'Ideas', path: 'ideas.md', content: 'Plant a garden next spring.' }),
      doc({ title: 'Garden', path: 'garden.md', content: 'Plant tomatoes next spring.' }),
    ])
    expect(titles(searchIndex(small, { query: 'garden' }))).toEqual(['Garden', 'Ideas'])
  })

  it('puts documents matching every word first', () => {
    const found = titles(searchIndex(index, { query: 'flour water' }))
    expect(found[0]).toBe('Sourdough starter')
    expect(found.slice(1).sort()).toEqual(['Shopping', 'Travel'])
  })

  it('matches only the last word as a prefix', () => {
    expect(titles(searchIndex(index, { query: 'pass' }))).toEqual(['Travel'])
    // "pass" is not the last word here, so it does not match "passport".
    const [result] = searchIndex(index, { query: 'pass bottle' })
    expect(result!.snippet.highlights.map(([start, end]) => result!.snippet.text.slice(start, end))).toEqual(['bottle'])
  })

  it('filters by source kind', () => {
    expect(titles(searchIndex(index, { query: 'flour', sources: ['keep'] }))).toEqual(['Shopping'])
    expect(titles(searchIndex(index, { query: 'login', sources: ['repo'] }))).toEqual(['auth.ts'])
  })

  it('returns results shaped like online search', () => {
    const [result] = searchIndex(index, { query: 'eggs' })
    expect(result).toMatchObject({
      documentId: docs[1]!.id,
      source: { kind: 'keep', name: 'keep' },
      path: 'Keep/Shopping',
      allowLlm: false,
      headingPath: '',
    })
    expect(result!.snippet.text.slice(...result!.snippet.highlights[0]!)).toBe('eggs')
  })

  it('returns nothing for an empty query or index', () => {
    expect(searchIndex(index, { query: '  ' })).toEqual([])
    expect(searchIndex(buildIndex([]), { query: 'flour' })).toEqual([])
  })
})

describe('makeSnippet', () => {
  it('opens a window around the first match with ellipses', () => {
    const content = `${'filler '.repeat(80)}the passport is in the drawer ${'more '.repeat(80)}`
    const snippet = makeSnippet(content, ['passport'])
    expect(snippet.text.startsWith('…')).toBe(true)
    expect(snippet.text.endsWith('…')).toBe(true)
    const [start, end] = snippet.highlights[0]!
    expect(snippet.text.slice(start, end)).toBe('passport')
  })

  it('highlights only at word starts and handles no matches', () => {
    const snippet = makeSnippet('Flour and cauliflower', ['flour'])
    expect(snippet.highlights).toEqual([[0, 5]])
    expect(makeSnippet('short text', [])).toEqual({ text: 'short text', highlights: [] })
  })
})

describe('searchOffline', () => {
  it('searches the cached documents and rebuilds after a sync', async () => {
    const db = new OfflineDb(`offline-search-${Math.random()}`)
    await db.documents.put(doc({ title: 'Garden', content: 'tomatoes and basil' }))
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '1', repos: [], syncedAt: null })
    expect(titles(await searchOffline({ query: 'basil' }, db))).toEqual(['Garden'])

    await db.documents.put(doc({ title: 'Pesto', content: 'basil, pine nuts, garlic' }))
    await db.state.put({ key: SYNC_STATE_KEY, cursor: '2', repos: [], syncedAt: null })
    expect(titles(await searchOffline({ query: 'basil' }, db)).sort()).toEqual(['Garden', 'Pesto'])
    db.close()
  })
})

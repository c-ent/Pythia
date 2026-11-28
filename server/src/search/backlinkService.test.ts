import { describe, expect, it } from 'vitest'
import type { BacklinkStore, LinkedDocument, SourceNote, StoredChunk, StoredNoteLink } from '../db/linkStore.js'
import { targetKey } from '../ingest/links.js'
import { createBacklinkService, linkPassage, MAX_BACKLINK_PASSAGE_CHARS, sourceLabel } from './backlinkService.js'

interface FakeDoc extends SourceNote {
  sourceId: number
  kind: LinkedDocument['sourceKind']
  links: Omit<StoredNoteLink, 'documentId' | 'ordinal'>[]
  chunks?: Omit<StoredChunk, 'documentId' | 'ordinal'>[]
}

const note = (over: Partial<FakeDoc> & Pick<FakeDoc, 'id' | 'path' | 'title'>): FakeDoc => ({
  sourceId: 1,
  kind: 'obsidian',
  allowLlm: true,
  aliases: [],
  links: [],
  ...over,
})

const wiki = (target: string, heading: string | null = null, display: string | null = null) =>
  ({ kind: 'wikilink', target, heading, display }) as const

/** In-memory `links`, with `linksTo` filtering by `target_key` as Postgres does. */
function fakeStore(docs: FakeDoc[]) {
  const linksOf = (doc: FakeDoc): StoredNoteLink[] =>
    doc.links.map((link, ordinal) => ({ ...link, documentId: doc.id, ordinal }))
  const calls = { chunks: [] as number[][] }
  const store: BacklinkStore = {
    async document(id) {
      const doc = docs.find((d) => d.id === id)
      return doc === undefined
        ? null
        : { id: doc.id, sourceId: doc.sourceId, sourceKind: doc.kind, sourceName: doc.kind === 'obsidian' ? 'vault' : doc.kind, path: doc.path, title: doc.title, aliases: doc.aliases }
    },
    async noteLinks(id) {
      const doc = docs.find((d) => d.id === id)
      return doc === undefined ? [] : linksOf(doc)
    },
    async linksTo(sourceId, keys) {
      return docs
        .filter((d) => d.sourceId === sourceId)
        .flatMap(linksOf)
        .filter((link) => keys.includes(targetKey(link.target)))
    },
    async notes(sourceId) {
      return docs
        .filter((d) => d.sourceId === sourceId)
        .map(({ id, path, title, allowLlm, aliases }) => ({ id, path, title, allowLlm, aliases }))
    },
    async chunks(ids) {
      calls.chunks.push([...ids])
      return docs
        .filter((d) => ids.includes(d.id))
        .flatMap((d) => (d.chunks ?? []).map((chunk, ordinal) => ({ ...chunk, documentId: d.id, ordinal })))
    },
  }
  return { store, calls }
}

describe('createBacklinkService', () => {
  const vault = (): FakeDoc[] => [
    note({ id: 1, path: 'Projects/Pythia.md', title: 'Pythia', aliases: ['Oracle'], links: [wiki('Bread'), wiki('Ghost'), wiki('Pythia', 'Goals')] }),
    note({
      id: 2,
      path: 'Kitchen/Bread log.md',
      title: 'Bread log',
      allowLlm: false,
      links: [wiki('Pythia', 'Goals', 'the project'), wiki('Oracle')],
      chunks: [{ headingPath: 'Bread log > March', content: 'Flour notes.\n\nTried [[Pythia#Goals|the project]] again.' }],
    }),
    note({ id: 3, path: 'Archive.md', title: 'archive', links: [{ kind: 'markdown', target: 'Projects/Pythia.md', heading: null, display: 'here' }] }),
    note({ id: 4, path: 'Bread.md', title: 'Bread' }),
    // Same name in another folder: its own folder's Pythia wins for this link.
    // Its path is longer, so links from a third folder go to Projects/Pythia.md.
    note({ id: 5, path: 'Elsewhere/Pythia.md', title: 'Pythia' }),
    note({ id: 6, path: 'Elsewhere/Index.md', title: 'Index', links: [wiki('Pythia')] }),
    // Another source never counts.
    note({ id: 7, path: 'Keep/Pythia.json', title: 'Pythia', sourceId: 2, kind: 'keep', links: [wiki('Pythia')] }),
  ]

  it('lists linking notes of the same source, by title then path, with count, first link and passage', async () => {
    const { store } = fakeStore(vault())
    const response = await createBacklinkService({ store }).backlinks({ documentId: 1 })
    expect(response?.supported).toBe(true)
    expect(response?.backlinks).toEqual([
      {
        id: 3,
        source: { kind: 'obsidian', name: 'vault' },
        sourceLabel: 'Obsidian',
        title: 'archive',
        allowLlm: true,
        count: 1,
        display: 'here',
        heading: null,
        passage: null,
      },
      {
        id: 2,
        source: { kind: 'obsidian', name: 'vault' },
        sourceLabel: 'Obsidian',
        title: 'Bread log',
        allowLlm: false,
        count: 2,
        display: 'the project',
        heading: 'Goals',
        passage: { headingPath: 'Bread log > March', text: 'Tried [[Pythia#Goals|the project]] again.' },
      },
    ])
  })

  it('resolves the note’s own links as written, a ghost to null', async () => {
    const { store } = fakeStore(vault())
    const response = await createBacklinkService({ store }).backlinks({ documentId: 1 })
    expect(response?.outgoing).toEqual([
      { target: 'Bread', heading: null, display: null, documentId: 4 },
      { target: 'Ghost', heading: null, display: null, documentId: null },
      { target: 'Pythia', heading: 'Goals', display: null, documentId: 1 },
    ])
  })

  it('gives the same-folder note the link of a duplicate name', async () => {
    const { store } = fakeStore(vault())
    const response = await createBacklinkService({ store }).backlinks({ documentId: 5 })
    expect(response?.backlinks.map((link) => link.id)).toEqual([6])
  })

  it('caps the list at the limit and reads chunks of the kept notes only', async () => {
    const { store, calls } = fakeStore(vault())
    const response = await createBacklinkService({ store }).backlinks({ documentId: 1, limit: 1 })
    expect(response?.backlinks.map((link) => link.id)).toEqual([3])
    expect(calls.chunks).toEqual([[3]])
  })

  it('is unsupported for repo and Drive documents, and null for a missing one', async () => {
    const { store } = fakeStore([note({ id: 9, path: 'README.md', title: 'README', kind: 'repo', links: [wiki('X')] })])
    const service = createBacklinkService({ store })
    expect(await service.backlinks({ documentId: 9 })).toEqual({ documentId: 9, supported: false, backlinks: [], outgoing: [] })
    expect(await service.backlinks({ documentId: 99 })).toBeNull()
  })
})

describe('linkPassage', () => {
  const link: StoredNoteLink = { documentId: 2, ordinal: 0, kind: 'wikilink', target: 'Pythia', heading: null, display: null }

  it('is the paragraph holding the link, capped', () => {
    const long = `${'word '.repeat(200)}[[Pythia]]`
    const passage = linkPassage([{ documentId: 2, ordinal: 0, headingPath: 'H', content: `Intro\n\n${long}` }], link)
    expect(passage?.headingPath).toBe('H')
    expect(passage?.text.length).toBeLessThanOrEqual(MAX_BACKLINK_PASSAGE_CHARS)
    expect(passage?.text.startsWith('word')).toBe(true)
  })

  it('is null when no stored paragraph holds the link', () => {
    expect(linkPassage([{ documentId: 2, ordinal: 0, headingPath: '', content: 'See `[[Pythia]]`' }], link)).toBeNull()
  })
})

describe('sourceLabel', () => {
  it('names notes by kind and repos by name', () => {
    expect(sourceLabel('obsidian', 'vault')).toBe('Obsidian')
    expect(sourceLabel('keep', 'keep')).toBe('Keep')
    expect(sourceLabel('repo', 'kitchen-app')).toBe('kitchen-app')
  })
})

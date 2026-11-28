import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb, type CachedLink, type CachedLinkKind, type CachedMapEntry } from './db'
import {
  backlinksFrom,
  buildOfflineMap,
  localGraphFrom,
  normalizePosix,
  offlineBacklinks,
  offlineLocalGraph,
  offlineRelated,
  relatedFrom,
} from './offlineMap'

const link = (kind: CachedLinkKind, target: string, extra: Partial<CachedLink> = {}): CachedLink => ({
  kind,
  target,
  heading: null,
  display: null,
  ...extra,
})

const entry = (id: number, path: string, overrides: Partial<CachedMapEntry> = {}): CachedMapEntry => ({
  id,
  sourceKind: 'obsidian',
  sourceName: 'vault',
  path,
  title: path.replace(/\.md$/, '').split('/').pop() ?? path,
  allowLlm: true,
  inMap: true,
  neighbours: [],
  links: [],
  ...overrides,
})

describe('offline map: link resolution', () => {
  it('normalizes paths like path.posix.normalize', () => {
    expect(normalizePosix('a/./b/../c')).toBe('a/c')
    expect(normalizePosix('../a')).toBe('../a')
    expect(normalizePosix('/a/../../b')).toBe('/b')
    expect(normalizePosix('')).toBe('.')
  })

  it('resolves by title, relative path and alias, and keeps ghosts', () => {
    const map = buildOfflineMap([
      entry(1, 'A.md', {
        links: [
          link('wikilink', 'B', { display: 'bee' }),
          link('markdown', 'sub/C.md'),
          link('wikilink', 'Dee'),
          link('wikilink', 'Missing'),
        ],
      }),
      entry(2, 'B.md'),
      entry(3, 'sub/C.md'),
      entry(4, 'D.md', { links: [link('alias', 'Dee')] }),
    ])
    expect(backlinksFrom(map, 1)?.outgoing).toEqual([
      { target: 'B', heading: null, display: 'bee', documentId: 2 },
      { target: 'sub/C.md', heading: null, display: null, documentId: 3 },
      { target: 'Dee', heading: null, display: null, documentId: 4 },
      { target: 'Missing', heading: null, display: null, documentId: null },
    ])
  })

  it('prefers a note in the linking note’s folder', () => {
    const map = buildOfflineMap([
      entry(1, 'x/A.md', { links: [link('wikilink', 'Note')] }),
      entry(2, 'y/Note.md'),
      entry(3, 'x/Note.md'),
    ])
    expect(backlinksFrom(map, 1)?.outgoing[0]?.documentId).toBe(3)
  })

  it('never resolves across sources', () => {
    const map = buildOfflineMap([
      entry(1, 'A.md', { links: [link('wikilink', 'B')] }),
      entry(2, 'B.md', { sourceKind: 'keep', sourceName: 'keep' }),
    ])
    expect(backlinksFrom(map, 1)?.outgoing[0]?.documentId).toBeNull()
  })
})

describe('offline map: backlinks', () => {
  it('groups links per linking note, sorted by title, without passages', () => {
    const map = buildOfflineMap([
      entry(1, 'Target.md', { links: [link('wikilink', 'Target')] }),
      entry(2, 'Zed.md', { links: [link('wikilink', 'Target', { heading: 'Intro' }), link('embed', 'Target')] }),
      entry(3, 'Alpha.md', { links: [link('wikilink', 'Target')], allowLlm: false }),
    ])
    const response = backlinksFrom(map, 1)
    expect(response?.supported).toBe(true)
    // The note's link to itself is not a backlink.
    expect(response?.backlinks.map((b) => [b.id, b.count])).toEqual([
      [3, 1],
      [2, 2],
    ])
    expect(response?.backlinks[0]).toMatchObject({ title: 'Alpha', allowLlm: false, sourceLabel: 'Obsidian', passage: null })
    expect(response?.backlinks[1]).toMatchObject({ heading: 'Intro' })
  })

  it('is unsupported for repo files and null for documents not on this device', () => {
    const map = buildOfflineMap([entry(10, 'src/a.ts', { sourceKind: 'repo', sourceName: 'kitchen-app' })])
    expect(backlinksFrom(map, 10)).toEqual({ supported: false, backlinks: [], outgoing: [] })
    expect(backlinksFrom(map, 99)).toBeNull()
  })
})

describe('offline map: related', () => {
  it('lists the stored neighbours held on this device, with the server’s bands', () => {
    const map = buildOfflineMap([
      entry(1, 'A.md', {
        neighbours: [
          { id: 2, score: 0.85 },
          { id: 3, score: 0.75 },
          { id: 4, score: 0.5 },
          { id: 5, score: 0.9 },
          { id: 6, score: 0.9 },
        ],
      }),
      entry(2, 'B.md'),
      entry(3, 'C.md'),
      entry(4, 'D.md'),
      // 5 is not on this device (an unpinned repo); 6 is no longer in the map.
      entry(6, 'F.md', { inMap: false }),
    ])
    const response = relatedFrom(map, 1)
    expect(response?.inMap).toBe(true)
    expect(response?.related.map((r) => [r.documentId, r.band])).toEqual([
      [2, 'strong'],
      [3, 'medium'],
      [4, 'weak'],
    ])
    expect(response?.related[0]).toMatchObject({ title: 'B', path: 'B.md', passage: null, source: { kind: 'obsidian', name: 'vault' } })
  })

  it('says when a document is not in the map, and null when it is not on this device', () => {
    const map = buildOfflineMap([entry(1, 'A.md', { inMap: false })])
    expect(relatedFrom(map, 1)).toEqual({ documentId: 1, inMap: false, related: [] })
    expect(relatedFrom(map, 2)).toBeNull()
  })
})

describe('offline map: local graph', () => {
  const entries = [
    entry(1, 'A.md', {
      links: [link('tag', 'project'), link('wikilink', 'B'), link('wikilink', 'Missing')],
      neighbours: [{ id: 3, score: 0.9 }],
    }),
    entry(2, 'B.md'),
    entry(3, 'C.md'),
    entry(4, 'D.md', { links: [link('tag', 'project')] }),
    entry(10, 'src/a.ts', { sourceKind: 'repo', sourceName: 'kitchen-app' }),
  ]

  it('builds the document and everything 2 steps out', () => {
    const graph = localGraphFrom(buildOfflineMap(entries), 1)
    expect(graph?.center).toBe('doc:1')
    expect(graph?.truncated).toBe(false)
    expect(graph?.nodes.map((n) => [n.id, n.depth])).toEqual([
      ['doc:1', 0],
      ['doc:2', 1],
      ['doc:3', 1],
      ['ghost:obsidian:vault|missing', 1],
      ['tag:project', 1],
      ['doc:4', 2],
    ])
    expect(graph?.edges).toHaveLength(5)
    expect(graph?.edges).toContainEqual({ source: 'doc:1', target: 'doc:3', kind: 'neighbour', score: 0.9 })
    expect(graph?.nodes[0]).toMatchObject({ label: 'A', links: 4, sourceLabel: 'Obsidian', documentId: 1 })
  })

  it('links repo files to their repo', () => {
    const graph = localGraphFrom(buildOfflineMap(entries), 10)
    expect(graph?.nodes.map((n) => n.id)).toEqual(['doc:10', 'repo:kitchen-app'])
  })

  it('stops at the node limit and says so', () => {
    const graph = localGraphFrom(buildOfflineMap(entries), 1, 3)
    expect(graph?.nodes).toHaveLength(3)
    expect(graph?.truncated).toBe(true)
  })

  it('has no graph outside the map, and null when the document is not on this device', () => {
    const map = buildOfflineMap([entry(1, 'A.md', { inMap: false })])
    expect(localGraphFrom(map, 1)).toMatchObject({ inMap: false, nodes: [], edges: [] })
    expect(localGraphFrom(map, 2)).toBeNull()
  })
})

describe('offline map: entry points', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the synced map rows from IndexedDB', async () => {
    const name = `pythia-map-test-${Math.random().toString(36).slice(2)}`
    const db = new OfflineDb(name)
    try {
      await db.map.bulkPut([
        entry(1, 'A.md', { links: [link('wikilink', 'B')], neighbours: [{ id: 2, score: 0.8 }] }),
        entry(2, 'B.md'),
      ])
      expect((await offlineRelated(1, () => db))?.related.map((r) => r.documentId)).toEqual([2])
      expect((await offlineBacklinks(2, () => db))?.backlinks.map((b) => b.id)).toEqual([1])
      expect((await offlineLocalGraph(1, () => db))?.nodes.map((n) => n.id)).toEqual(['doc:1', 'doc:2'])
      expect(await offlineRelated(3, () => db)).toBeNull()
    } finally {
      db.close()
      await OfflineDb.delete(name)
    }
  })

  it('answers null without opening a database when there is no IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const open = vi.fn(() => new OfflineDb('never-opened'))
    expect(await offlineRelated(1, open)).toBeNull()
    expect(await offlineBacklinks(1, open)).toBeNull()
    expect(await offlineLocalGraph(1, open)).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})

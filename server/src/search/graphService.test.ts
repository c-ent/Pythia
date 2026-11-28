import { describe, expect, it } from 'vitest'
import type { GraphFilters, GraphLinkRow, GraphStore, MapDocument, NeighbourRow } from '../db/graphStore.js'
import type { SearchableKind } from '../db/searchStore.js'
import { targetKey, type LinkKind } from '../ingest/links.js'
import { createGraphService, type GraphEdge } from './graphService.js'

interface FakeDoc extends MapDocument {
  inMap: boolean
  aliases: string[]
  links: { kind: LinkKind; target: string }[]
}

const sources: Record<string, { id: number; kind: SearchableKind; name: string }> = {
  vault: { id: 1, kind: 'obsidian', name: 'vault' },
  keep: { id: 2, kind: 'keep', name: 'keep' },
  repo: { id: 3, kind: 'repo', name: 'garden-app' },
  drive: { id: 4, kind: 'gdrive', name: 'gdrive' },
}

const doc = (
  id: number,
  source: keyof typeof sources,
  path: string,
  links: FakeDoc['links'] = [],
  over: Partial<FakeDoc> = {},
): FakeDoc => {
  const s = sources[source]!
  return {
    id,
    sourceId: s.id,
    sourceKind: s.kind,
    sourceName: s.name,
    path,
    title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    allowLlm: true,
    inMap: true,
    aliases: [],
    links,
    ...over,
  }
}

const wiki = (target: string) => ({ kind: 'wikilink' as const, target })
const tag = (target: string) => ({ kind: 'tag' as const, target })
const label = (target: string) => ({ kind: 'label' as const, target })

/** In-memory store with the Postgres store's visibility and filter rules. */
function fakeStore(docs: FakeDoc[], neighbours: NeighbourRow[]) {
  const calls: string[] = []
  const passes = (d: FakeDoc, f: GraphFilters): boolean =>
    d.inMap &&
    (d.id === f.always ||
      ((f.sources === undefined || f.sources.includes(d.sourceKind)) &&
        (f.repo === undefined || (d.sourceKind === 'repo' && d.sourceName === f.repo))))
  const linkRows = (d: FakeDoc): GraphLinkRow[] =>
    d.links.map((link, ordinal) => ({
      documentId: d.id,
      sourceId: d.sourceId,
      ordinal,
      kind: link.kind,
      target: link.target,
      targetKey: link.kind === 'tag' || link.kind === 'label' ? link.target.toLowerCase() : targetKey(link.target),
    }))
  const strip = (d: FakeDoc): MapDocument => ({
    id: d.id,
    sourceId: d.sourceId,
    sourceKind: d.sourceKind,
    sourceName: d.sourceName,
    path: d.path,
    title: d.title,
    allowLlm: d.allowLlm,
  })
  const store: GraphStore = {
    async document(id) {
      calls.push('document')
      const d = docs.find((x) => x.id === id)
      return d === undefined ? null : { ...strip(d), inMap: d.inMap }
    },
    async mapDocuments(query, filters) {
      calls.push('mapDocuments')
      return docs
        .filter((d) => passes(d, filters))
        .filter((d) => query.ids === undefined || query.ids.includes(d.id))
        .filter((d) => query.sourceIds === undefined || query.sourceIds.includes(d.sourceId))
        .map(strip)
    },
    async links(query, filters) {
      calls.push('links')
      return docs
        .filter((d) => passes(d, filters))
        .filter((d) => query.documentIds === undefined || query.documentIds.includes(d.id))
        .filter((d) => query.sourceId === undefined || d.sourceId === query.sourceId)
        .flatMap(linkRows)
        .filter((row) => query.kinds.includes(row.kind))
        .filter((row) => query.targetKeys === undefined || query.targetKeys.includes(row.targetKey))
    },
    async notes(sourceId) {
      calls.push('notes')
      return docs
        .filter((d) => d.sourceId === sourceId)
        .map((d) => ({ id: d.id, path: d.path, title: d.title, allowLlm: d.allowLlm, aliases: d.aliases }))
    },
    async neighbours(query, filters) {
      calls.push('neighbours')
      const ok = (id: number) => {
        const d = docs.find((x) => x.id === id)
        return d !== undefined && passes(d, filters)
      }
      return neighbours
        .filter((n) => ok(n.documentId) && ok(n.neighbourId))
        .filter((n) => query.maxRank === undefined || n.rank <= query.maxRank)
        .filter((n) => query.documentIds === undefined || query.documentIds.includes(n.documentId) || query.documentIds.includes(n.neighbourId))
    },
  }
  return { store, calls }
}

const n = (documentId: number, neighbourId: number, rank: number, score = 0.8): NeighbourRow => ({ documentId, neighbourId, rank, score })

// Garden (1) links to Tomatoes (2) and a missing note; Tomatoes links to Soil (3);
// Diary (4) links to Garden; Keep note (10) shares the #garden tag and is
// Garden's semantic neighbour; the repo README (20) is Keep's neighbour.
const fixture = () =>
  fakeStore(
    [
      doc(1, 'vault', 'Garden.md', [wiki('Tomatoes'), wiki('Missing'), tag('garden')]),
      doc(2, 'vault', 'Plants/Tomatoes.md', [wiki('Soil')]),
      doc(3, 'vault', 'Plants/Soil.md'),
      doc(4, 'vault', 'Diary.md', [wiki('Garden'), wiki('Missing')]),
      doc(5, 'vault', 'Far.md'),
      doc(10, 'keep', 'Keep/Garden.json', [label('Garden')]),
      doc(11, 'keep', 'Keep/Shopping.json', [label('garden')]),
      doc(20, 'repo', 'README.md'),
      doc(21, 'repo', 'docs/setup.md'),
      doc(22, 'repo', 'src/index.ts', [], { inMap: false }),
      doc(30, 'drive', 'Plans/garden.docx'),
    ],
    [n(1, 10, 1, 0.9), n(10, 1, 1, 0.9), n(10, 20, 2, 0.7), n(30, 5, 1), n(3, 30, 1)],
  )

const ids = (nodes: { id: string }[]) => nodes.map((node) => node.id).sort()
const has = (edges: GraphEdge[], source: string, target: string, kind: GraphEdge['kind']) =>
  edges.some((e) => e.kind === kind && ((e.source === source && e.target === target) || (kind === 'neighbour' && e.source === target && e.target === source)))

describe('local graph (R20)', () => {
  it('holds the document and everything 2 steps out, with depths', async () => {
    const { store } = fixture()
    const graph = await createGraphService({ store }).local({ documentId: 1 })
    expect(graph?.inMap).toBe(true)
    expect(graph?.center).toBe('doc:1')
    const depth = Object.fromEntries((graph?.nodes ?? []).map((node) => [node.id, node.depth]))
    expect(depth).toEqual({
      'doc:1': 0,
      'doc:2': 1, // own link
      'ghost:1:missing': 1, // missing note
      'tag:garden': 1, // own tag
      'doc:4': 1, // backlink
      'doc:10': 1, // neighbour
      'doc:3': 2, // Tomatoes → Soil
      'doc:11': 2, // shares the garden label/tag
      'doc:20': 2, // Keep note's neighbour
    })
    // Not 3 steps out: Soil's neighbour, the repo node behind the README, Far.
    expect(depth['doc:30']).toBeUndefined()
    expect(depth['repo:3']).toBeUndefined()
    expect(graph?.nodes[0]).toMatchObject({ id: 'doc:1', type: 'document', label: 'Garden', documentId: 1, sourceLabel: 'Obsidian', path: 'Garden.md' })
    expect(graph?.truncated).toBe(false)
  })

  it('returns typed edges and counts each node’s links', async () => {
    const { store } = fixture()
    const graph = (await createGraphService({ store }).local({ documentId: 1 }))!
    const e = graph.edges
    expect(has(e, 'doc:1', 'doc:2', 'link')).toBe(true)
    expect(has(e, 'doc:1', 'ghost:1:missing', 'link')).toBe(true)
    expect(has(e, 'doc:4', 'ghost:1:missing', 'link')).toBe(true)
    expect(has(e, 'doc:4', 'doc:1', 'link')).toBe(true)
    expect(has(e, 'doc:1', 'tag:garden', 'tag')).toBe(true)
    expect(has(e, 'doc:10', 'tag:garden', 'tag')).toBe(true)
    expect(has(e, 'doc:1', 'doc:10', 'neighbour')).toBe(true)
    // The two stored directions of one neighbour pair are one edge.
    expect(e.filter((edge) => edge.kind === 'neighbour' && [edge.source, edge.target].sort().join() === 'doc:1,doc:10')).toHaveLength(1)
    expect(e.find((edge) => edge.kind === 'neighbour')?.score).toBeCloseTo(0.9)
    for (const node of graph.nodes) {
      expect(node.links).toBe(e.filter((edge) => edge.source === node.id || edge.target === node.id).length)
    }
    expect(graph.nodes.find((node) => node.id === 'ghost:1:missing')).toMatchObject({ type: 'ghost', label: 'Missing', documentId: null, links: 2 })
  })

  it('hangs a repo document off its repo node', async () => {
    const { store } = fixture()
    const graph = (await createGraphService({ store }).local({ documentId: 20 }))!
    const depth = Object.fromEntries(graph.nodes.map((node) => [node.id, node.depth]))
    expect(depth['repo:3']).toBe(1)
    expect(depth['doc:21']).toBe(2)
    expect(depth['doc:22']).toBeUndefined() // code is not a map document
    expect(graph.nodes.find((node) => node.id === 'repo:3')).toMatchObject({ type: 'repo', label: 'garden-app', source: { kind: 'repo', name: 'garden-app' } })
  })

  it('applies source filters to every node but the opened document', async () => {
    const { store } = fixture()
    const graph = (await createGraphService({ store }).local({ documentId: 1, sources: ['keep'] }))!
    expect(ids(graph.nodes)).toEqual(['doc:1', 'doc:10', 'doc:11', 'tag:garden'])
    // No vault ghost when the vault is filtered out.
    expect(graph.nodes.some((node) => node.type === 'ghost')).toBe(false)
  })

  it('answers inMap false for a document outside the map, and null for a missing one', async () => {
    const { store } = fixture()
    const service = createGraphService({ store })
    expect(await service.local({ documentId: 22 })).toEqual({ documentId: 22, inMap: false, center: 'doc:22', nodes: [], edges: [], truncated: false })
    expect(await service.local({ documentId: 99 })).toBeNull()
  })

  it('keeps the best connected nodes when the graph is too big', async () => {
    const { store } = fixture()
    const graph = (await createGraphService({ store, maxLocalNodes: 4 }).local({ documentId: 1 }))!
    expect(graph.nodes).toHaveLength(4)
    expect(graph.truncated).toBe(true)
    expect(graph.nodes[0]?.id).toBe('doc:1')
    // Edges only join kept nodes.
    const kept = new Set(graph.nodes.map((node) => node.id))
    for (const edge of graph.edges) expect(kept.has(edge.source) && kept.has(edge.target)).toBe(true)
  })
})

describe('whole-vault graph (R20)', () => {
  it('holds every map document, tag and repo, links and the top 3 neighbours, no ghosts', async () => {
    const { store, calls } = fixture()
    const graph = await createGraphService({ store }).vault({})
    expect(ids(graph.nodes)).toEqual([
      'doc:1', 'doc:10', 'doc:11', 'doc:2', 'doc:20', 'doc:21', 'doc:3', 'doc:30', 'doc:4', 'doc:5', 'repo:3', 'tag:garden',
    ])
    expect(has(graph.edges, 'doc:1', 'doc:2', 'link')).toBe(true)
    expect(has(graph.edges, 'repo:3', 'doc:21', 'repo')).toBe(true)
    expect(has(graph.edges, 'doc:30', 'doc:5', 'neighbour')).toBe(true)
    expect(graph.nodes.find((node) => node.id === 'tag:garden')?.links).toBe(3)
    expect(graph.truncated).toBe(false)
    // Documents come first, then tags and repos.
    expect(graph.nodes.at(-1)?.type).toBe('repo')
    expect(calls).not.toContain('document')
  })

  it('uses only the first 3 stored neighbours of each document', async () => {
    const { store } = fakeStore(
      [1, 2, 3, 4, 5].map((id) => doc(id, 'vault', `N${id}.md`)),
      [n(1, 2, 1), n(1, 3, 2), n(1, 4, 3), n(1, 5, 4)],
    )
    const graph = await createGraphService({ store }).vault({})
    expect(graph.edges.map((edge) => edge.target)).toEqual(['doc:2', 'doc:3', 'doc:4'])
  })

  it('a filter to keep returns only Keep nodes and their tags', async () => {
    const { store } = fixture()
    const graph = await createGraphService({ store }).vault({ sources: ['keep'] })
    expect(ids(graph.nodes)).toEqual(['doc:10', 'doc:11', 'tag:garden'])
    expect(graph.edges.every((edge) => edge.kind === 'tag')).toBe(true)
  })

  it('a repo filter keeps that repo’s documents and its node', async () => {
    const { store } = fixture()
    const graph = await createGraphService({ store }).vault({ repo: 'garden-app' })
    expect(ids(graph.nodes)).toEqual(['doc:20', 'doc:21', 'repo:3'])
  })

  it('cuts to the best connected nodes over the cap', async () => {
    const { store } = fixture()
    const graph = await createGraphService({ store, maxVaultNodes: 3 }).vault({})
    expect(graph.nodes).toHaveLength(3)
    expect(graph.truncated).toBe(true)
    expect(graph.nodes.map((node) => node.id)).toContain('tag:garden')
  })
})

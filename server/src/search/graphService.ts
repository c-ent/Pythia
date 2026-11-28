import type { GraphFilters, GraphLinkRow, GraphStore, MapDocument } from '../db/graphStore.js'
import type { SourceNote } from '../db/linkStore.js'
import type { SearchableKind } from '../db/searchStore.js'
import { buildNoteIndex, NOTE_LINK_KINDS, noteKeys, resolveLink, type LinkKind, type NoteIndex, type NoteLinkKind } from '../ingest/links.js'
import { sourceLabel } from './backlinkService.js'
import type { SourceRef } from './searchService.js'

/**
 * Knowledge map graphs (R20, T70), shared by REST and later `/mcp`:
 * - the local graph of one map document: it and everything 2 steps out
 *   (note links, tags and Keep labels, its repo node, semantic neighbours,
 *   ghosts), with the edges found on the way;
 * - the whole-vault graph: every map document, tag and repo, with explicit
 *   links plus each document's top 3 stored neighbours.
 * Read from `links`, `document_neighbours` and `document_vectors` only: no
 * Ollama or Gemini call, and no document text in the response. Source and
 * repo filters are applied inside each store query (R4).
 */

/** Most nodes in a local graph; the 2-step ring is cut to the best connected. */
export const MAX_LOCAL_NODES = 200
/** Most nodes in the whole-vault graph; over it, the best connected are kept. */
export const MAX_VAULT_NODES = 5000
/** Stored neighbours per document used as edges in the whole-vault graph (R20). */
export const VAULT_NEIGHBOURS = 3

const LINKED_KINDS: readonly SearchableKind[] = ['obsidian', 'keep']
const TAG_KINDS: readonly LinkKind[] = ['tag', 'label']
const EDGE_LINK_KINDS: readonly LinkKind[] = [...NOTE_LINK_KINDS, ...TAG_KINDS]

export type GraphNodeType = 'document' | 'tag' | 'repo' | 'ghost'
/** `link`: a wikilink, embed or Markdown note link; `tag`: a tag or Keep label; `repo`: a repo's map document. */
export type GraphEdgeKind = 'link' | 'tag' | 'repo' | 'neighbour'

export interface GraphNode {
  /** `doc:<id>`, `tag:<key>`, `repo:<source id>` or `ghost:<source id>:<key>`. */
  id: string
  type: GraphNodeType
  /** Title, tag, repo name or the ghost link as written. */
  label: string
  /** Set for documents only. */
  documentId: number | null
  /** The document's or ghost's source, or the repo itself; null for tags. */
  source: SourceRef | null
  sourceLabel: string | null
  /** Set for documents only. */
  path: string | null
  /** Set for documents only. */
  allowLlm: boolean | null
  /** Edges of this node in the response. */
  links: number
}

export interface LocalGraphNode extends GraphNode {
  /** Steps from the opened document. */
  depth: 0 | 1 | 2
}

export interface GraphEdge {
  /** Linking note, tagged document, repo, or the document that lists the neighbour. */
  source: string
  target: string
  kind: GraphEdgeKind
  /** Cosine similarity for `neighbour` edges, else null. */
  score: number | null
}

export interface LocalGraphResponse {
  documentId: number
  /** False for a document outside the map (repo code, boilerplate, no stored chunks): no graph. */
  inMap: boolean
  /** Node id of the opened document. */
  center: string
  nodes: LocalGraphNode[]
  edges: GraphEdge[]
  /** True when nodes were left out to stay under `MAX_LOCAL_NODES`. */
  truncated: boolean
}

export interface VaultGraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** True when nodes were left out to stay under `MAX_VAULT_NODES`. */
  truncated: boolean
}

export interface GraphRequest {
  sources?: readonly SearchableKind[]
  repo?: string
}

export interface LocalGraphRequest extends GraphRequest {
  documentId: number
}

export interface GraphService {
  /** Null when the document does not exist or is not visible. */
  local(request: LocalGraphRequest): Promise<LocalGraphResponse | null>
  vault(request: GraphRequest): Promise<VaultGraphResponse>
}

export interface GraphServiceOptions {
  store: GraphStore
  maxLocalNodes?: number
  maxVaultNodes?: number
}

type NodeRef =
  | { type: 'document'; id: string; documentId: number }
  | { type: 'tag'; id: string; key: string; label: string }
  | { type: 'repo'; id: string; sourceId: number; name: string }
  | { type: 'ghost'; id: string; sourceId: number; key: string; label: string; source: SourceRef }

interface Connection {
  from: NodeRef
  to: NodeRef
  kind: GraphEdgeKind
  score: number | null
}

const docRef = (documentId: number): NodeRef => ({ type: 'document', id: `doc:${documentId}`, documentId })
// A tag and a Keep label with the same key are one node; the key is its label, so the label never depends on row order.
const tagRef = (row: GraphLinkRow): NodeRef => ({ type: 'tag', id: `tag:${row.targetKey}`, key: row.targetKey, label: row.targetKey })
const repoRef = (doc: MapDocument): NodeRef => ({ type: 'repo', id: `repo:${doc.sourceId}`, sourceId: doc.sourceId, name: doc.sourceName })
const ghostRef = (row: GraphLinkRow, source: SourceRef): NodeRef => ({
  type: 'ghost',
  id: `ghost:${row.sourceId}:${row.targetKey}`,
  sourceId: row.sourceId,
  key: row.targetKey,
  label: row.target,
  source,
})

const isNoteLink = (kind: LinkKind): kind is NoteLinkKind => (NOTE_LINK_KINDS as readonly string[]).includes(kind)

const edgeKey = (edge: GraphEdge): string =>
  edge.kind === 'neighbour'
    ? `neighbour|${[edge.source, edge.target].sort().join('|')}`
    : `${edge.kind}|${edge.source}|${edge.target}`

const TYPE_ORDER: Record<GraphNodeType, number> = { document: 0, ghost: 1, tag: 2, repo: 3 }

const groupBy = <T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list === undefined) out.set(k, [item])
    else list.push(item)
  }
  return out
}

interface SourceIndex {
  index: NoteIndex<SourceNote>
  byId: Map<number, SourceNote>
}

/** One request's lookups: note indexes per source and map documents by id, each read once. */
function createContext(store: GraphStore, filters: GraphFilters) {
  const indexes = new Map<number, Promise<SourceIndex>>()
  const docs = new Map<number, MapDocument | null>()

  const indexFor = (sourceId: number): Promise<SourceIndex> => {
    let index = indexes.get(sourceId)
    if (index === undefined) {
      index = store.notes(sourceId).then((notes) => ({
        index: buildNoteIndex(notes),
        byId: new Map(notes.map((note) => [note.id, note])),
      }))
      indexes.set(sourceId, index)
    }
    return index
  }

  const remember = (doc: MapDocument): void => {
    docs.set(doc.id, doc)
  }

  /** Reads the documents not seen yet; ids that are not visible map documents become null. */
  const hydrate = async (ids: Iterable<number>): Promise<void> => {
    const missing = [...new Set(ids)].filter((id) => !docs.has(id)).sort((a, b) => a - b)
    if (missing.length === 0) return
    for (const doc of await store.mapDocuments({ ids: missing }, filters)) remember(doc)
    for (const id of missing) if (!docs.has(id)) docs.set(id, null)
  }

  return { indexFor, remember, hydrate, doc: (id: number) => docs.get(id) ?? null }
}

type Context = ReturnType<typeof createContext>

const sourceOf = (doc: MapDocument): SourceRef => ({ kind: doc.sourceKind, name: doc.sourceName })

/** The source and repo filters alone, for nodes the store queries do not return (ghosts). */
const passes = (doc: MapDocument, filters: GraphFilters): boolean =>
  (filters.sources === undefined || filters.sources.includes(doc.sourceKind)) &&
  (filters.repo === undefined || (doc.sourceKind === 'repo' && doc.sourceName === filters.repo))

/** Every connection of these documents one step out. */
async function expandDocuments(store: GraphStore, ctx: Context, filters: GraphFilters, frontier: readonly MapDocument[]): Promise<Connection[]> {
  const out: Connection[] = []
  const ids = frontier.map((doc) => doc.id)
  const byId = new Map(frontier.map((doc) => [doc.id, doc]))
  const linked = frontier.filter((doc) => LINKED_KINDS.includes(doc.sourceKind))

  // Repo documents hang off their repo node.
  for (const doc of frontier) {
    if (doc.sourceKind === 'repo') out.push({ from: repoRef(doc), to: docRef(doc.id), kind: 'repo', score: null })
  }

  if (linked.length > 0) {
    // Own note links (resolved or ghost), tags and labels.
    const own = await store.links({ kinds: EDGE_LINK_KINDS, documentIds: linked.map((doc) => doc.id) }, filters)
    for (const row of own) {
      const from = byId.get(row.documentId)
      if (from === undefined) continue
      if (!isNoteLink(row.kind)) {
        out.push({ from: docRef(from.id), to: tagRef(row), kind: 'tag', score: null })
        continue
      }
      const { index } = await ctx.indexFor(row.sourceId)
      const hit = resolveLink(index, from.path, { kind: row.kind, target: row.target })
      if (hit === null) {
        // A ghost belongs to the linking note's source: it shows only when that source passes the filters.
        if (passes(from, filters)) out.push({ from: docRef(from.id), to: ghostRef(row, sourceOf(from)), kind: 'link', score: null })
      } else if (hit.id !== from.id) out.push({ from: docRef(from.id), to: docRef(hit.id), kind: 'link', score: null })
    }

    // Backlinks: candidates by `target_key`, kept when they resolve to one of these notes.
    for (const [sourceId, docs] of groupBy(linked, (doc) => doc.sourceId)) {
      const { index, byId: notes } = await ctx.indexFor(sourceId)
      const wanted = new Set(docs.map((doc) => doc.id))
      const keys = [
        ...new Set(docs.flatMap((doc) => noteKeys({ path: doc.path, title: doc.title, aliases: notes.get(doc.id)?.aliases ?? [] }))),
      ]
      const incoming = await store.links({ kinds: NOTE_LINK_KINDS, targetKeys: keys, sourceId }, filters)
      for (const row of incoming) {
        const fromNote = notes.get(row.documentId)
        if (fromNote === undefined || !isNoteLink(row.kind)) continue
        const hit = resolveLink(index, fromNote.path, { kind: row.kind, target: row.target })
        if (hit === null || hit.id === row.documentId || !wanted.has(hit.id)) continue
        out.push({ from: docRef(row.documentId), to: docRef(hit.id), kind: 'link', score: null })
      }
    }
  }

  // Semantic neighbours, in either direction of the stored lists.
  for (const row of await store.neighbours({ documentIds: ids }, filters)) {
    out.push({ from: docRef(row.documentId), to: docRef(row.neighbourId), kind: 'neighbour', score: row.score })
  }
  return out
}

/** Documents carrying these tags or labels. */
async function expandTags(store: GraphStore, filters: GraphFilters, tags: readonly Extract<NodeRef, { type: 'tag' }>[]): Promise<Connection[]> {
  if (tags.length === 0) return []
  const rows = await store.links({ kinds: TAG_KINDS, targetKeys: tags.map((tag) => tag.key) }, filters)
  return rows.map((row) => ({ from: docRef(row.documentId), to: tagRef(row), kind: 'tag', score: null }))
}

/** A repo's map documents. */
async function expandRepos(store: GraphStore, ctx: Context, filters: GraphFilters, repos: readonly Extract<NodeRef, { type: 'repo' }>[]): Promise<Connection[]> {
  if (repos.length === 0) return []
  const docs = await store.mapDocuments({ sourceIds: repos.map((repo) => repo.sourceId) }, filters)
  for (const doc of docs) ctx.remember(doc)
  return docs.map((doc) => ({ from: repoRef(doc), to: docRef(doc.id), kind: 'repo', score: null }))
}

/** Other notes whose link to the same missing note is a ghost too. */
async function expandGhosts(store: GraphStore, ctx: Context, filters: GraphFilters, ghosts: readonly Extract<NodeRef, { type: 'ghost' }>[]): Promise<Connection[]> {
  const out: Connection[] = []
  for (const [sourceId, group] of groupBy(ghosts, (ghost) => ghost.sourceId)) {
    const { index, byId: notes } = await ctx.indexFor(sourceId)
    const byKey = new Map(group.map((ghost) => [ghost.key, ghost]))
    const rows = await store.links({ kinds: NOTE_LINK_KINDS, targetKeys: [...byKey.keys()], sourceId }, filters)
    for (const row of rows) {
      const ghost = byKey.get(row.targetKey)
      const fromNote = notes.get(row.documentId)
      if (ghost === undefined || fromNote === undefined || !isNoteLink(row.kind)) continue
      if (resolveLink(index, fromNote.path, { kind: row.kind, target: row.target }) !== null) continue
      out.push({ from: docRef(row.documentId), to: ghost, kind: 'link', score: null })
    }
  }
  return out
}

async function expand(store: GraphStore, ctx: Context, filters: GraphFilters, frontier: readonly NodeRef[]): Promise<Connection[]> {
  const docs: MapDocument[] = []
  const tags: Extract<NodeRef, { type: 'tag' }>[] = []
  const repos: Extract<NodeRef, { type: 'repo' }>[] = []
  const ghosts: Extract<NodeRef, { type: 'ghost' }>[] = []
  for (const ref of frontier) {
    if (ref.type === 'document') {
      const doc = ctx.doc(ref.documentId)
      if (doc !== null) docs.push(doc)
    } else if (ref.type === 'tag') tags.push(ref)
    else if (ref.type === 'repo') repos.push(ref)
    else ghosts.push(ref)
  }
  const found = [
    ...(docs.length === 0 ? [] : await expandDocuments(store, ctx, filters, docs)),
    ...(await expandTags(store, filters, tags)),
    ...(await expandRepos(store, ctx, filters, repos)),
    ...(await expandGhosts(store, ctx, filters, ghosts)),
  ]
  // A connection to a document that is not a visible map document passing the filters goes.
  await ctx.hydrate(found.flatMap((c) => [c.from, c.to]).flatMap((ref) => (ref.type === 'document' ? [ref.documentId] : [])))
  return found.filter((c) => [c.from, c.to].every((ref) => ref.type !== 'document' || ctx.doc(ref.documentId) !== null))
}

function toNode(ref: NodeRef, ctx: Context): GraphNode {
  switch (ref.type) {
    case 'document': {
      const doc = ctx.doc(ref.documentId)!
      return {
        id: ref.id,
        type: 'document',
        label: doc.title === '' ? doc.path : doc.title,
        documentId: doc.id,
        source: sourceOf(doc),
        sourceLabel: sourceLabel(doc.sourceKind, doc.sourceName),
        path: doc.path,
        allowLlm: doc.allowLlm,
        links: 0,
      }
    }
    case 'tag':
      return { id: ref.id, type: 'tag', label: ref.label, documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 0 }
    case 'repo':
      return {
        id: ref.id,
        type: 'repo',
        label: ref.name,
        documentId: null,
        source: { kind: 'repo', name: ref.name },
        sourceLabel: ref.name,
        path: null,
        allowLlm: null,
        links: 0,
      }
    case 'ghost':
      return {
        id: ref.id,
        type: 'ghost',
        label: ref.label,
        documentId: null,
        source: ref.source,
        sourceLabel: sourceLabel(ref.source.kind, ref.source.name),
        path: null,
        allowLlm: null,
        links: 0,
      }
  }
}

/** Unique edges between kept nodes, and each node's edge count. */
function finishEdges<T extends GraphNode>(nodes: Map<string, T>, connections: readonly Connection[]): GraphEdge[] {
  const edges = new Map<string, GraphEdge>()
  for (const c of connections) {
    if (c.from.id === c.to.id || !nodes.has(c.from.id) || !nodes.has(c.to.id)) continue
    const edge: GraphEdge = { source: c.from.id, target: c.to.id, kind: c.kind, score: c.score }
    const key = edgeKey(edge)
    if (!edges.has(key)) edges.set(key, edge)
  }
  for (const node of nodes.values()) node.links = 0
  for (const edge of edges.values()) {
    nodes.get(edge.source)!.links++
    nodes.get(edge.target)!.links++
  }
  return [...edges.values()]
}

const byLabel = (a: GraphNode, b: GraphNode): number =>
  TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
  a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Counts connections per new node, for keeping the best connected when a ring is too big. */
function rankNew(connections: readonly Connection[], known: ReadonlySet<string>): NodeRef[] {
  const refs = new Map<string, { ref: NodeRef; count: number }>()
  for (const c of connections) {
    for (const ref of [c.from, c.to]) {
      if (known.has(ref.id)) continue
      const entry = refs.get(ref.id)
      if (entry === undefined) refs.set(ref.id, { ref, count: 1 })
      else entry.count++
    }
  }
  return [...refs.values()]
    .sort((a, b) => b.count - a.count || (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0))
    .map((entry) => entry.ref)
}

export function createGraphService(options: GraphServiceOptions): GraphService {
  const { store } = options
  const maxLocal = options.maxLocalNodes ?? MAX_LOCAL_NODES
  const maxVault = options.maxVaultNodes ?? MAX_VAULT_NODES

  return {
    async local(request) {
      const center = await store.document(request.documentId)
      if (center === null) return null
      const centerId = `doc:${center.id}`
      if (!center.inMap) return { documentId: center.id, inMap: false, center: centerId, nodes: [], edges: [], truncated: false }

      // The opened document is shown whatever the filters say; its neighbours are filtered.
      const filters: GraphFilters = { sources: request.sources, repo: request.repo, always: center.id }
      const ctx = createContext(store, filters)
      ctx.remember(center)

      const depth = new Map<string, { ref: NodeRef; depth: 0 | 1 | 2 }>([[centerId, { ref: docRef(center.id), depth: 0 }]])
      const connections: Connection[] = []
      let truncated = false
      let frontier: NodeRef[] = [docRef(center.id)]
      for (const level of [1, 2] as const) {
        const found = await expand(store, ctx, filters, frontier)
        connections.push(...found)
        const fresh = rankNew(found, new Set(depth.keys()))
        const room = Math.max(0, maxLocal - depth.size)
        if (fresh.length > room) truncated = true
        frontier = fresh.slice(0, room)
        for (const ref of frontier) depth.set(ref.id, { ref, depth: level })
      }

      const nodes = new Map<string, LocalGraphNode>()
      for (const [id, entry] of depth) nodes.set(id, { ...toNode(entry.ref, ctx), depth: entry.depth })
      const edges = finishEdges(nodes, connections)
      const ordered = [...nodes.values()].sort((a, b) => a.depth - b.depth || byLabel(a, b))
      return { documentId: center.id, inMap: true, center: centerId, nodes: ordered, edges, truncated }
    },

    async vault(request) {
      const filters: GraphFilters = { sources: request.sources, repo: request.repo }
      const ctx = createContext(store, filters)
      const docs = await store.mapDocuments({}, filters)
      for (const doc of docs) ctx.remember(doc)
      const byId = new Map(docs.map((doc) => [doc.id, doc]))

      const refs = new Map<string, NodeRef>(docs.map((doc) => [`doc:${doc.id}`, docRef(doc.id)]))
      const connections: Connection[] = []
      const add = (c: Connection): void => {
        for (const ref of [c.from, c.to]) if (!refs.has(ref.id)) refs.set(ref.id, ref)
        connections.push(c)
      }

      for (const doc of docs) if (doc.sourceKind === 'repo') add({ from: repoRef(doc), to: docRef(doc.id), kind: 'repo', score: null })

      // Ghosts are left out of the whole-vault graph: its nodes are map documents, tags and repos (R20).
      for (const row of await store.links({ kinds: EDGE_LINK_KINDS }, filters)) {
        const from = byId.get(row.documentId)
        if (from === undefined) continue
        if (!isNoteLink(row.kind)) {
          add({ from: docRef(from.id), to: tagRef(row), kind: 'tag', score: null })
          continue
        }
        const { index } = await ctx.indexFor(row.sourceId)
        const hit = resolveLink(index, from.path, { kind: row.kind, target: row.target })
        if (hit !== null && hit.id !== from.id && byId.has(hit.id)) add({ from: docRef(from.id), to: docRef(hit.id), kind: 'link', score: null })
      }

      for (const row of await store.neighbours({ maxRank: VAULT_NEIGHBOURS }, filters)) {
        if (byId.has(row.documentId) && byId.has(row.neighbourId)) {
          add({ from: docRef(row.documentId), to: docRef(row.neighbourId), kind: 'neighbour', score: row.score })
        }
      }

      let nodes = new Map<string, GraphNode>([...refs].map(([id, ref]) => [id, toNode(ref, ctx)]))
      let edges = finishEdges(nodes, connections)
      let truncated = false
      if (nodes.size > maxVault) {
        truncated = true
        const kept = [...nodes.values()]
          .sort((a, b) => b.links - a.links || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, maxVault)
        nodes = new Map(kept.map((node) => [node.id, node]))
        edges = finishEdges(nodes, connections)
      }
      return { nodes: [...nodes.values()].sort(byLabel), edges, truncated }
    },
  }
}

import type { Backlink, BacklinksResponse, OutgoingLink } from '../api/backlinks'
import type { GraphEdge, GraphEdgeKind, GraphNode, LocalGraphNode, LocalGraphResponse } from '../api/graph'
import type { RelatedDocument, RelatedResponse, ScoreBand } from '../api/related'
import type { SourceKind, SourceRef } from '../api/search'
import { offlineDb, type CachedLink, type CachedMapEntry, type OfflineDb } from './db'

/**
 * The knowledge map from this device's offline copy (R20, R11, T72): Related,
 * backlinks and the local graph, built from the synced map rows (`db.map`)
 * with the server's rules (server/src/search/relatedService.ts,
 * backlinkService.ts, graphService.ts; links resolved like
 * server/src/ingest/links.ts). Only synced documents exist here, so work
 * material, switched-off sources and unpinned repos never appear. No text is
 * read: passages need the server, so offline answers carry none.
 */

/** Same as the server (graphService.ts). */
export const OFFLINE_MAX_LOCAL_NODES = 200
/** Same as the server's DEFAULT_BACKLINKS. */
const MAX_OFFLINE_BACKLINKS = 50
/** Same bands as the server (relatedService.ts). */
const BAND_STRONG = 0.8
const BAND_MEDIUM = 0.7

type NoteLinkKind = 'wikilink' | 'embed' | 'markdown'
const NOTE_LINK_KINDS: readonly string[] = ['wikilink', 'embed', 'markdown']
const isNoteLink = (link: CachedLink): link is CachedLink & { kind: NoteLinkKind } => NOTE_LINK_KINDS.includes(link.kind)
const isTag = (link: CachedLink): boolean => link.kind === 'tag' || link.kind === 'label'
const hasNoteLinks = (entry: CachedMapEntry): boolean => entry.sourceKind === 'obsidian' || entry.sourceKind === 'keep'

const scoreBand = (score: number): ScoreBand => (score >= BAND_STRONG ? 'strong' : score >= BAND_MEDIUM ? 'medium' : 'weak')

const sourceOf = (entry: Pick<CachedMapEntry, 'sourceKind' | 'sourceName'>): SourceRef => ({
  kind: entry.sourceKind as SourceKind,
  name: entry.sourceName,
})

/** The server's `sourceLabel` (backlinkService.ts). */
const sourceLabel = (kind: string, name: string): string =>
  kind === 'obsidian' ? 'Obsidian' : kind === 'keep' ? 'Keep' : kind === 'gdrive' ? 'Drive' : name

const sourceKey = (entry: Pick<CachedMapEntry, 'sourceKind' | 'sourceName'>): string => `${entry.sourceKind}:${entry.sourceName}`

// ---- Link resolution, as in server/src/ingest/links.ts ----

const MD_EXTENSION = /\.md$/i

/** NFC, trimmed, `/` separators, no `.md`, lower case. */
export function nameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\\/g, '/').replace(MD_EXTENSION, '').toLowerCase()
}

/** The last path part of `nameKey`. */
export function targetKey(target: string): string {
  const key = nameKey(target)
  const slash = key.lastIndexOf('/')
  return slash === -1 ? key : key.slice(slash + 1)
}

/** `path.posix.normalize`, which the browser does not have. */
export function normalizePosix(input: string): string {
  if (input === '') return '.'
  const absolute = input.startsWith('/')
  const trailing = input.endsWith('/')
  const out: string[] = []
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  let joined = out.join('/')
  if (joined === '' && !absolute) joined = '.'
  if (trailing && joined !== '' && joined !== '.') joined += '/'
  return absolute ? `/${joined}` : joined
}

const folderOf = (notePath: string): string => {
  const slash = notePath.lastIndexOf('/')
  return slash === -1 ? '' : notePath.slice(0, slash)
}

interface NoteIndex {
  notes: readonly CachedMapEntry[]
  byPath: Map<string, CachedMapEntry[]>
  byTitle: Map<string, CachedMapEntry[]>
  byAlias: Map<string, CachedMapEntry[]>
}

const push = <K, T>(map: Map<K, T[]>, key: K, value: T): void => {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

const aliasesOf = (entry: CachedMapEntry): string[] =>
  entry.links.filter((link) => link.kind === 'alias').map((link) => link.target)

function buildNoteIndex(notes: readonly CachedMapEntry[]): NoteIndex {
  const index: NoteIndex = { notes, byPath: new Map(), byTitle: new Map(), byAlias: new Map() }
  for (const note of notes) {
    push(index.byPath, nameKey(note.path), note)
    push(index.byTitle, nameKey(note.title), note)
    for (const alias of aliasesOf(note)) push(index.byAlias, nameKey(alias), note)
  }
  return index
}

function pick(candidates: readonly CachedMapEntry[] | undefined, fromPath: string): CachedMapEntry | null {
  if (candidates === undefined || candidates.length === 0) return null
  const folder = folderOf(fromPath)
  const rank = (note: CachedMapEntry): number => (folderOf(note.path) === folder ? 0 : 1)
  return (
    [...candidates].sort(
      (a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )[0] ?? null
  )
}

/** The note a link points to, or null for a ghost: by path, then title, then aliases. */
export function resolveLink(index: NoteIndex, fromPath: string, link: { kind: NoteLinkKind; target: string }): CachedMapEntry | null {
  const raw = link.target.normalize('NFC').trim().replace(/\\/g, '/')
  if (link.kind === 'markdown' && !raw.startsWith('/')) {
    const folder = folderOf(fromPath)
    const relative = normalizePosix(folder === '' ? raw : `${folder}/${raw}`)
    if (relative !== '..' && !relative.startsWith('../')) {
      const hit = pick(index.byPath.get(nameKey(relative)), fromPath)
      if (hit !== null) return hit
    }
  }
  const key = nameKey(normalizePosix(raw.replace(/^\/+/, '')))
  if (key.includes('/')) {
    const exact = pick(index.byPath.get(key), fromPath)
    if (exact !== null) return exact
    const suffix = pick(
      index.notes.filter((note) => nameKey(note.path).endsWith(`/${key}`)),
      fromPath,
    )
    if (suffix !== null) return suffix
  }
  return pick(index.byTitle.get(key), fromPath) ?? pick(index.byAlias.get(key), fromPath)
}

// ---- One snapshot of the map rows ----

interface ResolvedLink {
  from: CachedMapEntry
  link: CachedLink & { kind: NoteLinkKind }
  /** Null for a ghost. */
  to: CachedMapEntry | null
}

/** The map rows read once, with every note link resolved once. */
export interface OfflineMap {
  byId: Map<number, CachedMapEntry>
  /** Note links by linking document, in stored order. */
  outgoing: Map<number, ResolvedLink[]>
  /** Resolved note links by target document. */
  incoming: Map<number, ResolvedLink[]>
  /** Ghost links by `<source>|<target key>`. */
  ghosts: Map<string, ResolvedLink[]>
  /** Map documents by tag or label key. */
  tagged: Map<string, CachedMapEntry[]>
  /** Map documents by repo name. */
  repos: Map<string, CachedMapEntry[]>
  /** Who lists a document as a neighbour: listing id and score. */
  listedBy: Map<number, Array<{ id: number; score: number }>>
}

const tagKey = (link: CachedLink): string => (link.kind === 'tag' ? link.target : link.target.normalize('NFC').trim().toLowerCase())
const ghostKey = (from: CachedMapEntry, link: CachedLink): string => `${sourceKey(from)}|${targetKey(link.target)}`

export function buildOfflineMap(entries: readonly CachedMapEntry[]): OfflineMap {
  const map: OfflineMap = {
    byId: new Map(entries.map((entry) => [entry.id, entry])),
    outgoing: new Map(),
    incoming: new Map(),
    ghosts: new Map(),
    tagged: new Map(),
    repos: new Map(),
    listedBy: new Map(),
  }
  const bySource = new Map<string, CachedMapEntry[]>()
  for (const entry of entries) push(bySource, sourceKey(entry), entry)

  for (const notes of bySource.values()) {
    if (!hasNoteLinks(notes[0]!)) continue
    const index = buildNoteIndex(notes)
    for (const from of notes) {
      const own: ResolvedLink[] = []
      for (const link of from.links) {
        if (!isNoteLink(link)) continue
        const resolved: ResolvedLink = { from, link, to: resolveLink(index, from.path, link) }
        own.push(resolved)
        if (resolved.to === null) push(map.ghosts, ghostKey(from, link), resolved)
        else push(map.incoming, resolved.to.id, resolved)
      }
      map.outgoing.set(from.id, own)
    }
  }

  for (const entry of entries) {
    if (!entry.inMap) continue
    if (entry.sourceKind === 'repo') push(map.repos, entry.sourceName, entry)
    if (hasNoteLinks(entry)) for (const link of entry.links) if (isTag(link)) push(map.tagged, tagKey(link), entry)
    for (const neighbour of entry.neighbours) {
      const list = map.listedBy.get(neighbour.id) ?? []
      list.push({ id: entry.id, score: neighbour.score })
      map.listedBy.set(neighbour.id, list)
    }
  }
  return map
}

/**
 * Reads the map rows (no document text, so cheap next to the text cache);
 * null when there is no IndexedDB (old browsers, some tests).
 */
export async function readOfflineMap(db: OfflineDb): Promise<OfflineMap | null> {
  if (typeof indexedDB === 'undefined') return null
  return buildOfflineMap(await db.map.toArray())
}

// ---- Related ----

/** The Related list of a cached document, or null when it is not in the offline copy. */
export function relatedFrom(map: OfflineMap, id: number): RelatedResponse | null {
  const doc = map.byId.get(id)
  if (doc === undefined) return null
  if (!doc.inMap) return { documentId: id, inMap: false, related: [] }
  const related: RelatedDocument[] = []
  for (const neighbour of doc.neighbours) {
    const other = map.byId.get(neighbour.id)
    // A neighbour this device does not hold (an unpinned repo) is left out.
    if (other === undefined || !other.inMap) continue
    related.push({
      documentId: other.id,
      source: sourceOf(other),
      path: other.path,
      title: other.title,
      allowLlm: other.allowLlm,
      score: neighbour.score,
      band: scoreBand(neighbour.score),
      passage: null,
    })
  }
  return { documentId: id, inMap: true, related }
}

// ---- Backlinks ----

const byTitleThenPath = (a: CachedMapEntry, b: CachedMapEntry): number => {
  const title = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  if (title !== 0) return title
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** Backlinks and resolved outgoing links of a cached note, or null when it is not in the offline copy. */
export function backlinksFrom(map: OfflineMap, id: number): BacklinksResponse | null {
  const doc = map.byId.get(id)
  if (doc === undefined) return null
  if (!hasNoteLinks(doc)) return { supported: false, backlinks: [], outgoing: [] }

  const outgoing: OutgoingLink[] = (map.outgoing.get(id) ?? []).map(({ link, to }) => ({
    target: link.target,
    heading: link.heading,
    display: link.display,
    documentId: to?.id ?? null,
  }))

  const groups = new Map<number, { note: CachedMapEntry; links: CachedLink[] }>()
  for (const { from, link } of map.incoming.get(id) ?? []) {
    if (from.id === id) continue
    const group = groups.get(from.id)
    if (group === undefined) groups.set(from.id, { note: from, links: [link] })
    else group.links.push(link)
  }
  const backlinks = [...groups.values()]
    .sort((a, b) => byTitleThenPath(a.note, b.note))
    .slice(0, MAX_OFFLINE_BACKLINKS)
    .map(({ note, links }): Backlink => {
      const first = links[0]!
      return {
        id: note.id,
        source: sourceOf(doc),
        sourceLabel: sourceLabel(doc.sourceKind, doc.sourceName),
        title: note.title,
        allowLlm: note.allowLlm,
        count: links.length,
        display: first.display,
        heading: first.heading,
        passage: null,
      }
    })
  return { supported: true, backlinks, outgoing }
}

// ---- Local graph ----

type NodeRef =
  | { type: 'document'; id: string; documentId: number }
  | { type: 'tag'; id: string; key: string }
  | { type: 'repo'; id: string; name: string }
  | { type: 'ghost'; id: string; key: string; label: string; source: CachedMapEntry }

interface Connection {
  from: NodeRef
  to: NodeRef
  kind: GraphEdgeKind
  score: number | null
}

const docRef = (documentId: number): NodeRef => ({ type: 'document', id: `doc:${documentId}`, documentId })
const tagRef = (key: string): NodeRef => ({ type: 'tag', id: `tag:${key}`, key })
const repoRef = (name: string): NodeRef => ({ type: 'repo', id: `repo:${name}`, name })
const ghostRef = (from: CachedMapEntry, link: CachedLink): NodeRef => {
  const key = ghostKey(from, link)
  return { type: 'ghost', id: `ghost:${key}`, key, label: link.target, source: from }
}

const TYPE_ORDER: Record<GraphNode['type'], number> = { document: 0, ghost: 1, tag: 2, repo: 3 }

const edgeKey = (edge: GraphEdge): string =>
  edge.kind === 'neighbour' ? `neighbour|${[edge.source, edge.target].sort().join('|')}` : `${edge.kind}|${edge.source}|${edge.target}`

/** Connections of one node, one step out; documents only when they are map documents on this device. */
function expandNode(map: OfflineMap, ref: NodeRef): Connection[] {
  const out: Connection[] = []
  const isMapDoc = (id: number): boolean => map.byId.get(id)?.inMap === true
  switch (ref.type) {
    case 'document': {
      const doc = map.byId.get(ref.documentId)
      if (doc === undefined || !doc.inMap) return out
      if (doc.sourceKind === 'repo') out.push({ from: repoRef(doc.sourceName), to: ref, kind: 'repo', score: null })
      if (hasNoteLinks(doc)) {
        for (const link of doc.links) if (isTag(link)) out.push({ from: ref, to: tagRef(tagKey(link)), kind: 'tag', score: null })
        for (const { link, to } of map.outgoing.get(doc.id) ?? []) {
          if (to === null) out.push({ from: ref, to: ghostRef(doc, link), kind: 'link', score: null })
          else if (to.id !== doc.id && isMapDoc(to.id)) out.push({ from: ref, to: docRef(to.id), kind: 'link', score: null })
        }
        for (const { from } of map.incoming.get(doc.id) ?? []) {
          if (from.id !== doc.id && isMapDoc(from.id)) out.push({ from: docRef(from.id), to: ref, kind: 'link', score: null })
        }
      }
      for (const neighbour of doc.neighbours) {
        if (isMapDoc(neighbour.id)) out.push({ from: ref, to: docRef(neighbour.id), kind: 'neighbour', score: neighbour.score })
      }
      for (const lister of map.listedBy.get(doc.id) ?? []) {
        if (isMapDoc(lister.id)) out.push({ from: docRef(lister.id), to: ref, kind: 'neighbour', score: lister.score })
      }
      return out
    }
    case 'tag':
      for (const doc of map.tagged.get(ref.key) ?? []) out.push({ from: docRef(doc.id), to: ref, kind: 'tag', score: null })
      return out
    case 'repo':
      for (const doc of map.repos.get(ref.name) ?? []) out.push({ from: ref, to: docRef(doc.id), kind: 'repo', score: null })
      return out
    case 'ghost':
      for (const { from } of map.ghosts.get(ref.key) ?? []) {
        if (isMapDoc(from.id)) out.push({ from: docRef(from.id), to: ref, kind: 'link', score: null })
      }
      return out
  }
}

/** Connections per new node, best connected first (the server's `rankNew`). */
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

function toNode(map: OfflineMap, ref: NodeRef, depth: 0 | 1 | 2): LocalGraphNode {
  const base = { documentId: null, source: null, sourceLabel: null, path: null, allowLlm: null, links: 0, depth }
  switch (ref.type) {
    case 'document': {
      const doc = map.byId.get(ref.documentId)!
      return {
        ...base,
        id: ref.id,
        type: 'document',
        label: doc.title === '' ? doc.path : doc.title,
        documentId: doc.id,
        source: sourceOf(doc),
        sourceLabel: sourceLabel(doc.sourceKind, doc.sourceName),
        path: doc.path,
        allowLlm: doc.allowLlm,
      }
    }
    case 'tag':
      return { ...base, id: ref.id, type: 'tag', label: ref.key }
    case 'repo':
      return { ...base, id: ref.id, type: 'repo', label: ref.name, source: { kind: 'repo', name: ref.name }, sourceLabel: ref.name }
    case 'ghost':
      return {
        ...base,
        id: ref.id,
        type: 'ghost',
        label: ref.label,
        source: sourceOf(ref.source),
        sourceLabel: sourceLabel(ref.source.sourceKind, ref.source.sourceName),
      }
  }
}

/**
 * The local graph of a cached document, like the server's (no filters): it and
 * everything 2 steps out, at most `maxNodes`. Null when it is not in the
 * offline copy.
 */
export function localGraphFrom(map: OfflineMap, id: number, maxNodes = OFFLINE_MAX_LOCAL_NODES): LocalGraphResponse | null {
  const center = map.byId.get(id)
  if (center === undefined) return null
  const centerId = `doc:${id}`
  if (!center.inMap) return { documentId: id, inMap: false, center: centerId, nodes: [], edges: [], truncated: false }

  const depth = new Map<string, { ref: NodeRef; depth: 0 | 1 | 2 }>([[centerId, { ref: docRef(id), depth: 0 }]])
  const connections: Connection[] = []
  let truncated = false
  let frontier: NodeRef[] = [docRef(id)]
  for (const level of [1, 2] as const) {
    const found = frontier.flatMap((ref) => expandNode(map, ref))
    connections.push(...found)
    const fresh = rankNew(found, new Set(depth.keys()))
    const room = Math.max(0, maxNodes - depth.size)
    if (fresh.length > room) truncated = true
    frontier = fresh.slice(0, room)
    for (const ref of frontier) depth.set(ref.id, { ref, depth: level })
  }

  const nodes = new Map<string, LocalGraphNode>()
  for (const [nodeId, entry] of depth) nodes.set(nodeId, toNode(map, entry.ref, entry.depth))
  const edges = new Map<string, GraphEdge>()
  for (const c of connections) {
    if (c.from.id === c.to.id || !nodes.has(c.from.id) || !nodes.has(c.to.id)) continue
    const edge: GraphEdge = { source: c.from.id, target: c.to.id, kind: c.kind, score: c.score }
    const key = edgeKey(edge)
    if (!edges.has(key)) edges.set(key, edge)
  }
  for (const edge of edges.values()) {
    nodes.get(edge.source)!.links++
    nodes.get(edge.target)!.links++
  }
  const ordered = [...nodes.values()].sort(
    (a, b) =>
      a.depth - b.depth ||
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return { documentId: id, inMap: true, center: centerId, nodes: ordered, edges: [...edges.values()], truncated }
}

// ---- Entry points for the document page ----
// The database is opened only once IndexedDB is known to exist.

export async function offlineRelated(id: number, db: () => OfflineDb = offlineDb): Promise<RelatedResponse | null> {
  const map = typeof indexedDB === 'undefined' ? null : await readOfflineMap(db())
  return map === null ? null : relatedFrom(map, id)
}

export async function offlineBacklinks(id: number, db: () => OfflineDb = offlineDb): Promise<BacklinksResponse | null> {
  const map = typeof indexedDB === 'undefined' ? null : await readOfflineMap(db())
  return map === null ? null : backlinksFrom(map, id)
}

export async function offlineLocalGraph(id: number, db: () => OfflineDb = offlineDb): Promise<LocalGraphResponse | null> {
  const map = typeof indexedDB === 'undefined' ? null : await readOfflineMap(db())
  return map === null ? null : localGraphFrom(map, id)
}

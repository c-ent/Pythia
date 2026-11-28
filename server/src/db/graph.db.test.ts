import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { extractLinks } from '../ingest/links.js'
import { createGraphService, type GraphService } from '../search/graphService.js'
import { createPgGraphStore } from './graphStore.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore, type SourceRow } from './indexStore.js'
import { runMigrations } from './migrate.js'
import { refreshNeighbours } from './neighbourStore.js'

const MODEL = 'nomic-embed-text'

/** A 768-dim vector with the given entries set and every other one 0. */
const v = (entries: Record<number, number>): number[] => {
  const out = new Array<number>(768).fill(0)
  for (const [index, value] of Object.entries(entries)) out[Number(index)] = value
  return out
}

const chunk = (content: string, embedding: number[]): ChunkWrite => ({
  ordinal: 0,
  headingPath: '',
  startLine: null,
  endLine: null,
  content,
  embedding,
})

/** A document whose links come from its text, as the vault and Keep indexers write them. */
const write = (
  store: IndexStore,
  source: SourceRow,
  docPath: string,
  text: string,
  embedding: number[],
  options: { yaml?: string | null; labels?: string[]; linked?: boolean } = {},
) => {
  const title = docPath.slice(docPath.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const links = options.linked === false ? [] : extractLinks({ yaml: options.yaml ?? null, contents: [text], labels: options.labels })
  return store.replaceDocument(
    source.id,
    { path: docPath, title, language: null, contentHash: text, allowLlm: true, mtime: null, links },
    [chunk(text, embedding)],
    MODEL,
  )
}

// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('graphs (R20, T70)', () => {
  const dbName = `pythia_graph_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: IndexStore
  let service: GraphService
  let vault: SourceRow
  let keep: SourceRow
  let repo: SourceRow
  let workDoc: number

  const idOf = async (docPath: string): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM documents WHERE path = $1', [docPath])
    if (rows[0] === undefined) throw new Error(`no document ${docPath}`)
    return Number(rows[0].id)
  }

  const labels = (nodes: { label: string }[]) => nodes.map((node) => node.label).sort()

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
    store = createPgIndexStore(pool)
    service = createGraphService({ store: createPgGraphStore(pool) })
    vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    keep = await ensureSource(pool, 'keep', 'keep', 'takeout')
    repo = await ensureSource(pool, 'repo', 'garden-app', '/mirrors/garden-app')

    await write(store, vault, 'Garden.md', 'Plans for [[Tomatoes]] and [[Missing]]. #garden', v({ 0: 1 }))
    await write(store, vault, 'Plants/Tomatoes.md', 'Needs [[Soil]].', v({ 1: 1 }))
    await write(store, vault, 'Plants/Soil.md', 'Loam.', v({ 2: 1 }))
    await write(store, vault, 'Diary.md', 'Worked in the [[Garden]].', v({ 3: 1 }))
    // Same subject as Garden.md, no link between them; shares the garden label.
    await write(store, keep, 'Keep/Garden.json', 'Tomatoes need sun', v({ 0: 1, 1: 0.05 }), { labels: ['Garden'] })
    await write(store, repo, 'README.md', 'Garden app', v({ 0: 1, 4: 1 }), { linked: false })
    await write(store, repo, 'docs/setup.md', 'Setup', v({ 4: 1 }), { linked: false })
    // Searchable, never in the map: code and boilerplate, even pointing the same way.
    await write(store, repo, 'src/garden.ts', 'export const garden = 1', v({ 0: 1 }), { linked: false })
    await write(store, repo, 'LICENSE', 'MIT License', v({ 0: 1 }), { linked: false })

    // A work document with a vector and a link to Garden: it must never appear.
    const work = await pool.query<{ id: string }>(
      "INSERT INTO sources (kind, name, root_path) VALUES ('work', 'work', '/work') RETURNING id",
    )
    const doc = await pool.query<{ id: string }>(
      "INSERT INTO documents (source_id, path, title, content_hash) VALUES ($1, 'Garden work.md', 'Garden work', 'h') RETURNING id",
      [work.rows[0]!.id],
    )
    workDoc = Number(doc.rows[0]!.id)
    await pool.query('INSERT INTO document_vectors (document_id, embedding, embed_model) VALUES ($1, $2::vector, $3)', [
      workDoc,
      `[${v({ 0: 1 }).join(',')}]`,
      MODEL,
    ])
    await pool.query(
      "INSERT INTO links (document_id, ordinal, kind, target, target_key) VALUES ($1, 0, 'wikilink', 'Garden', 'garden'), ($1, 1, 'tag', 'garden', 'garden')",
      [workDoc],
    )

    const refreshed = await refreshNeighbours(pool, { log: () => {} })
    expect(refreshed.failed).toBe(0)
    // Keep the work document out of every stored list, as the indexers do (work is never indexed).
    await pool.query('DELETE FROM document_neighbours WHERE document_id = $1 OR neighbour_id = $1', [workDoc])
    // A work row in a list would be filtered by the readers anyway; plant one to prove it.
    await pool.query(
      'INSERT INTO document_neighbours (document_id, neighbour_id, rank, score, embed_model) VALUES ($1, $2, 8, 0.99, $3) ON CONFLICT DO NOTHING',
      [await idOf('Garden.md'), workDoc, MODEL],
    )
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('builds the local graph 2 steps out: links, ghost, tag, neighbours, repo node', async () => {
    const garden = await idOf('Garden.md')
    const graph = await service.local({ documentId: garden })
    expect(graph?.inMap).toBe(true)
    const depth = Object.fromEntries((graph?.nodes ?? []).map((node) => [node.label, node.depth]))
    expect(depth['Garden']).toBe(0)
    expect(depth['Tomatoes']).toBe(1)
    expect(depth['Missing']).toBe(1)
    expect(depth['garden']).toBe(1)
    expect(depth['Diary']).toBe(1)
    expect(depth['Garden.json']).toBe(1)
    expect(depth['README']).toBe(1)
    expect(depth['Soil']).toBe(2)
    expect(depth['garden-app']).toBe(2)
    expect(graph?.nodes.find((node) => node.label === 'Missing')?.type).toBe('ghost')
    expect(graph?.nodes.find((node) => node.label === 'garden-app')?.type).toBe('repo')
  })

  it('never shows work documents, code or boilerplate', async () => {
    const garden = await idOf('Garden.md')
    const graphs = [(await service.local({ documentId: garden }))!, await service.vault({})]
    const ids = new Set([workDoc, await idOf('src/garden.ts'), await idOf('LICENSE')])
    for (const graph of graphs) {
      expect(graph.nodes.some((node) => node.documentId !== null && ids.has(node.documentId))).toBe(false)
      expect(labels(graph.nodes)).not.toContain('Garden work')
    }
    expect(await service.local({ documentId: workDoc })).toBeNull()
    const code = await service.local({ documentId: await idOf('src/garden.ts') })
    expect(code).toMatchObject({ inMap: false, nodes: [], edges: [] })
  })

  it('builds the whole-vault graph from every map document, tag and repo', async () => {
    const graph = await service.vault({})
    expect(labels(graph.nodes)).toEqual(
      ['Diary', 'Garden', 'Garden.json', 'README', 'Soil', 'Tomatoes', 'garden', 'garden-app', 'setup'].sort(),
    )
    expect(graph.nodes.some((node) => node.type === 'ghost')).toBe(false)
    const tag = graph.nodes.find((node) => node.type === 'tag')!
    // Garden.md and the Keep note carry it; the work note does not count.
    expect(tag.links).toBe(2)
    for (const node of graph.nodes) {
      expect(node.links).toBe(graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length)
    }
  })

  it('a filter to keep returns only Keep nodes and their tags', async () => {
    const graph = await service.vault({ sources: ['keep'] })
    expect(graph.nodes.map((node) => [node.type, node.label])).toEqual([
      ['document', 'Garden.json'],
      ['tag', 'garden'],
    ])
    const local = await service.local({ documentId: await idOf('Garden.md'), sources: ['keep'] })
    expect(labels(local?.nodes ?? [])).toEqual(['Garden', 'Garden.json', 'garden'])
  })

  it('a repo filter returns only that repo’s map documents and its node', async () => {
    const graph = await service.vault({ repo: 'garden-app' })
    expect(labels(graph.nodes)).toEqual(['README', 'garden-app', 'setup'])
  })

  it('hides a switched-off source', async () => {
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [keep.id])
    try {
      const graph = await service.vault({})
      expect(graph.nodes.some((node) => node.source?.kind === 'keep')).toBe(false)
      expect(await service.local({ documentId: await idOf('Keep/Garden.json') })).toBeNull()
    } finally {
      await pool.query('UPDATE sources SET enabled = true WHERE id = $1', [keep.id])
    }
  })
})

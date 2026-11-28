import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { extractLinks, type LinkWrite } from '../ingest/links.js'
import { createBacklinkService, type BacklinkService } from '../search/backlinkService.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore, type SourceRow } from './indexStore.js'
import { createPgBacklinkStore } from './linkStore.js'
import { runMigrations } from './migrate.js'

const MODEL = 'nomic-embed-text'

const chunk = (ordinal: number, content: string): ChunkWrite => ({
  ordinal,
  headingPath: '',
  startLine: null,
  endLine: null,
  content,
  embedding: new Array<number>(768).fill(0).map((_, i) => (i === ordinal ? 1 : 0)),
})

/** A note whose links come from its text, as the vault indexer writes them. */
const write = (store: IndexStore, source: SourceRow, path: string, text: string, yaml: string | null = null) => {
  const title = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const links: LinkWrite[] = extractLinks({ yaml, contents: [text] })
  return store.replaceDocument(
    source.id,
    { path, title, language: 'markdown', contentHash: text, allowLlm: true, mtime: null, links },
    [chunk(0, text)],
    MODEL,
  )
}

// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('links and backlinks (R20)', () => {
  const dbName = `pythia_links_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: IndexStore
  let service: BacklinkService
  let vault: SourceRow
  let keep: SourceRow

  const idOf = async (path: string): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM documents WHERE path = $1', [path])
    if (rows[0] === undefined) throw new Error(`no document ${path}`)
    return Number(rows[0].id)
  }

  const backlinkTitles = async (path: string): Promise<string[] | undefined> =>
    (await service.backlinks({ documentId: await idOf(path) }))?.backlinks.map((link) => link.title)

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
    service = createBacklinkService({ store: createPgBacklinkStore(pool) })
    vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    keep = await ensureSource(pool, 'keep', 'keep', 'takeout')

    await write(store, vault, 'Projects/Pythia.md', 'Plans for [[Bread]] and [[Ghost]].', 'aliases: [Oracle]')
    await write(store, vault, 'Bread.md', 'A loaf.')
    await write(store, vault, 'Kitchen/Bread log.md', 'Flour.\n\nTried [[Pythia#Goals|the project]] and [[Oracle]] again.')
    // Same title in two folders: a link from Work/ resolves to Work/Index.md.
    await write(store, vault, 'Work/Index.md', 'Work index.')
    await write(store, vault, 'Home/Index.md', 'Home index.')
    await write(store, vault, 'Work/Todo.md', 'See [[Index]].')
    // Another source with a note of the same name never counts.
    await write(store, keep, 'Keep/Pythia', 'Keep note about [[Pythia]].')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('writes the rows in order: alias first, then links', async () => {
    const { rows } = await pool.query<{ ordinal: number; kind: string; target: string; target_key: string }>(
      'SELECT ordinal, kind, target, target_key FROM links WHERE document_id = $1 ORDER BY ordinal',
      [await idOf('Projects/Pythia.md')],
    )
    expect(rows).toEqual([
      { ordinal: 0, kind: 'alias', target: 'Oracle', target_key: 'oracle' },
      { ordinal: 1, kind: 'wikilink', target: 'Bread', target_key: 'bread' },
      { ordinal: 2, kind: 'wikilink', target: 'Ghost', target_key: 'ghost' },
    ])
  })

  it('lists a backlink by title and by alias as one note with a count, the first link and its passage', async () => {
    const response = await service.backlinks({ documentId: await idOf('Projects/Pythia.md') })
    expect(response?.supported).toBe(true)
    expect(response?.backlinks).toEqual([
      {
        id: await idOf('Kitchen/Bread log.md'),
        source: { kind: 'obsidian', name: 'vault' },
        sourceLabel: 'Obsidian',
        title: 'Bread log',
        allowLlm: true,
        count: 2,
        display: 'the project',
        heading: 'Goals',
        passage: { headingPath: '', text: 'Tried [[Pythia#Goals|the project]] and [[Oracle]] again.' },
      },
    ])
  })

  it('resolves outgoing links as written, with a ghost as null', async () => {
    const response = await service.backlinks({ documentId: await idOf('Projects/Pythia.md') })
    expect(response?.outgoing).toEqual([
      { target: 'Bread', heading: null, display: null, documentId: await idOf('Bread.md') },
      { target: 'Ghost', heading: null, display: null, documentId: null },
    ])
  })

  it('gives a duplicate title to the linking note’s own folder', async () => {
    expect(await backlinkTitles('Work/Index.md')).toEqual(['Todo'])
    expect(await backlinkTitles('Home/Index.md')).toEqual([])
  })

  it('replaceLinks rewrites the links and leaves chunks alone', async () => {
    const id = await idOf('Bread.md')
    const before = await pool.query('SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY ordinal', [id])
    await store.replaceLinks(vault.id, 'Bread.md', extractLinks({ yaml: null, contents: ['Goes with [[Pythia]].'] }))
    const after = await pool.query('SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY ordinal', [id])
    expect(after.rows).toEqual(before.rows)
    expect(await backlinkTitles('Projects/Pythia.md')).toEqual(['Bread', 'Bread log'])
    await store.replaceLinks(vault.id, 'Bread.md', [])
    expect(await backlinkTitles('Projects/Pythia.md')).toEqual(['Bread log'])
  })

  it('drops the old links on a rename, and the link becomes a ghost', async () => {
    await write(store, vault, 'Kitchen/Rye.md', 'More [[Bread]].')
    expect(await backlinkTitles('Bread.md')).toEqual(['Pythia', 'Rye'])

    await store.deleteDocuments(vault.id, ['Kitchen/Rye.md'])
    await write(store, vault, 'Kitchen/Rye bread.md', 'More [[Bread]].')
    const left = await pool.query("SELECT 1 FROM links l JOIN documents d ON d.id = l.document_id WHERE d.path = 'Kitchen/Rye.md'")
    expect(left.rowCount).toBe(0)
    expect(await backlinkTitles('Bread.md')).toEqual(['Pythia', 'Rye bread'])

    await store.deleteDocuments(vault.id, ['Bread.md'])
    await write(store, vault, 'Loaf.md', 'A loaf.')
    const outgoing = (await service.backlinks({ documentId: await idOf('Projects/Pythia.md') }))?.outgoing
    expect(outgoing?.[0]).toEqual({ target: 'Bread', heading: null, display: null, documentId: null })
  })

  it('keeps sources apart and hides switched-off sources and work', async () => {
    const keepNote = await idOf('Keep/Pythia')
    expect((await service.backlinks({ documentId: keepNote }))?.outgoing).toEqual([
      { target: 'Pythia', heading: null, display: null, documentId: keepNote },
    ])
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [keep.id])
    try {
      expect(await service.backlinks({ documentId: keepNote })).toBeNull()
    } finally {
      await pool.query('UPDATE sources SET enabled = true WHERE id = $1', [keep.id])
    }
    const work = await pool.query<{ id: string }>(
      "INSERT INTO sources (kind, name, root_path) VALUES ('work', 'work', '/work') RETURNING id",
    )
    const doc = await pool.query<{ id: string }>(
      "INSERT INTO documents (source_id, path, title, content_hash) VALUES ($1, 'w.md', 'W', 'h') RETURNING id",
      [work.rows[0]!.id],
    )
    expect(await service.backlinks({ documentId: Number(doc.rows[0]!.id) })).toBeNull()
  })

  it('answers unsupported for a repo document', async () => {
    const repo = await ensureSource(pool, 'repo', 'garden-app', '/mirrors/garden-app')
    await write(store, repo, 'README.md', 'See [[Pythia]].')
    const id = await idOf('README.md')
    expect(await service.backlinks({ documentId: id })).toEqual({ documentId: id, supported: false, backlinks: [], outgoing: [] })
  })
})

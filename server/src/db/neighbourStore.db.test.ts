import pg from 'pg'
import { dropTestDatabase } from './testDatabase.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore, type SourceRow } from './indexStore.js'
import { runMigrations } from './migrate.js'
import { createPgRelatedStore, refreshNeighbours, type RelatedStore } from './neighbourStore.js'

const MODEL = 'nomic-embed-text'

/** A 768-dim vector with the given entries set and every other one 0. */
const v = (entries: Record<number, number>): number[] => {
  const out = new Array<number>(768).fill(0)
  for (const [index, value] of Object.entries(entries)) out[Number(index)] = value
  return out
}

const chunk = (ordinal: number, embedding: number[], content = `chunk ${ordinal}`): ChunkWrite => ({
  ordinal,
  headingPath: '',
  startLine: null,
  endLine: null,
  content,
  embedding,
})

const doc = (docPath: string, contentHash = 'h') => ({
  path: docPath,
  title: docPath,
  language: null,
  contentHash,
  allowLlm: true,
  mtime: null,
})

const quiet = { log: () => {} }

// Opt-in with PYTHIA_DB_TESTS=1; uses its own throwaway database.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('document_neighbours (R20 semantic neighbours)', () => {
  const dbName = `pythia_neighbours_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: IndexStore
  let related: RelatedStore
  let vault: SourceRow
  let keep: SourceRow
  let drive: SourceRow
  let repo: SourceRow

  const idOf = async (docPath: string): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM documents WHERE path = $1', [docPath])
    if (rows[0] === undefined) throw new Error(`no document ${docPath}`)
    return Number(rows[0].id)
  }

  const relatedPaths = async (docPath: string, filters: { sources?: string[]; repo?: string } = {}) => {
    const lookup = await related.related({
      documentId: await idOf(docPath),
      filters: filters as never,
      limit: 8,
      cutoff: 0.6,
    })
    return lookup?.hits.map((hit) => hit.path) ?? null
  }

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
    related = createPgRelatedStore(pool)
    vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    keep = await ensureSource(pool, 'keep', 'keep', 'takeout')
    drive = await ensureSource(pool, 'gdrive', 'gdrive', '/data/gdrive')
    repo = await ensureSource(pool, 'repo', 'garden-app', '/mirrors/garden-app')

    // The opened note, and a Keep note about the same thing with no link to it.
    await store.replaceDocument(vault.id, doc('Garden.md'), [chunk(0, v({ 0: 1 }), 'Planting tomatoes')], MODEL)
    await store.replaceDocument(
      keep.id,
      doc('Keep/Garden.json'),
      [chunk(0, v({ 0: 1, 1: 0.05 }), 'Tomatoes need sun'), chunk(1, v({ 0: 1, 2: 0.3 }), 'Water every morning')],
      MODEL,
    )
    await store.replaceDocument(drive.id, doc('Plans/garden.docx'), [chunk(0, v({ 0: 1, 3: 0.6 }))], MODEL)
    await store.replaceDocument(repo.id, doc('README.md'), [chunk(0, v({ 0: 1, 4: 1 }))], MODEL)
    // Same direction as the note, but code: searchable, never in the map.
    await store.replaceDocument(repo.id, doc('src/garden.ts'), [chunk(0, v({ 0: 1 }))], MODEL)
    // Unrelated (cosine 0), and one embedded with another model.
    await store.replaceDocument(vault.id, doc('Taxes.md'), [chunk(0, v({ 5: 1 }))], MODEL)
    await store.replaceDocument(vault.id, doc('Old model.md'), [chunk(0, v({ 0: 1 }))], 'other-model')
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  it('lists the planted near-duplicate in another source first, then the weaker ones', async () => {
    const result = await refreshNeighbours(pool, quiet)
    expect(result.failed).toBe(0)
    // Every map document with a vector: 5 in nomic-embed-text, 1 in other-model.
    expect(result.refreshed).toBe(6)
    expect(await relatedPaths('Garden.md')).toEqual(['Keep/Garden.json', 'Plans/garden.docx', 'README.md'])

    const lookup = await related.related({ documentId: await idOf('Garden.md'), filters: {}, limit: 8, cutoff: 0.6 })
    const [top, second, third] = lookup?.hits ?? []
    expect(top).toMatchObject({ sourceKind: 'keep', sourceName: 'keep', title: 'Keep/Garden.json', allowLlm: true })
    expect(top?.score).toBeGreaterThan(0.98)
    // The passage is the neighbour's chunk closest to the opened note.
    expect(top?.passage?.content).toBe('Tomatoes need sun')
    expect(second?.score).toBeCloseTo(1 / Math.sqrt(1.36), 4)
    expect(third?.score).toBeCloseTo(Math.SQRT1_2, 4)
  })

  it('never lists a document as its own neighbour', async () => {
    const self = await pool.query('SELECT 1 FROM document_neighbours WHERE document_id = neighbour_id')
    expect(self.rowCount).toBe(0)
    expect(await relatedPaths('Keep/Garden.json')).not.toContain('Keep/Garden.json')
    const id = await idOf('Garden.md')
    await expect(
      pool.query("INSERT INTO document_neighbours VALUES ($1, $1, 1, 1, 'nomic-embed-text')", [id]),
    ).rejects.toThrow(/check constraint/)
  })

  it('stores nothing below the cut-off, and never compares across models', async () => {
    expect(await relatedPaths('Taxes.md')).toEqual([])
    expect(await relatedPaths('Old model.md')).toEqual([])
    const lists = await pool.query<{ path: string }>(
      `SELECT DISTINCT d.path FROM document_neighbours n JOIN documents d ON d.id = n.neighbour_id`,
    )
    expect(lists.rows.map((row) => row.path)).not.toContain('Old model.md')
    expect(lists.rows.map((row) => row.path)).not.toContain('Taxes.md')
  })

  it('keeps repo code out: it is never a neighbour and has none', async () => {
    const code = await related.related({ documentId: await idOf('src/garden.ts'), filters: {}, limit: 8, cutoff: 0.6 })
    expect(code).toEqual({ inMap: false, hits: [] })
    expect(await relatedPaths('Garden.md')).not.toContain('src/garden.ts')
  })

  it('applies source and repo filters inside the ranking', async () => {
    expect(await relatedPaths('Garden.md', { sources: ['gdrive'] })).toEqual(['Plans/garden.docx'])
    expect(await relatedPaths('Garden.md', { repo: 'garden-app' })).toEqual(['README.md'])
    expect(await relatedPaths('Garden.md', { repo: 'other' })).toEqual([])

    // Eight closer notes fill the stored top 8, so the Drive document drops
    // out of the stored list; a Drive filter still finds it.
    for (let i = 0; i < 8; i++) {
      await store.replaceDocument(vault.id, doc(`Close ${i}.md`), [chunk(0, v({ 0: 1, [10 + i]: 0.01 * (i + 1) }))], MODEL)
    }
    await refreshNeighbours(pool, quiet)
    const unfiltered = await relatedPaths('Garden.md')
    expect(unfiltered).toHaveLength(8)
    expect(unfiltered).not.toContain('Plans/garden.docx')
    expect(await relatedPaths('Garden.md', { sources: ['gdrive'] })).toEqual(['Plans/garden.docx'])
    expect(await relatedPaths('Garden.md', { sources: ['keep', 'gdrive'] })).toEqual(['Keep/Garden.json', 'Plans/garden.docx'])
  })

  it('refreshes nothing when nothing changed', async () => {
    expect(await refreshNeighbours(pool, quiet)).toEqual({ refreshed: 0, failed: 0 })
  })

  it('refreshes a changed document and the documents that listed it', async () => {
    // A note in Garden.md's list is rewritten about something else.
    await store.replaceDocument(vault.id, doc('Close 0.md', 'h2'), [chunk(0, v({ 7: 1 }))], MODEL)
    const result = await refreshNeighbours(pool, quiet)
    expect(result.failed).toBe(0)
    // Close 0 itself, plus Garden.md and the other notes that listed it.
    expect(result.refreshed).toBeGreaterThan(1)
    const garden = await relatedPaths('Garden.md')
    expect(garden).not.toContain('Close 0.md')
    expect(await relatedPaths('Close 0.md')).toEqual([])
    // Its old slot in the note's list went to the next nearest.
    expect(garden).toHaveLength(8)
    expect(garden).toContain('Keep/Garden.json')
  })

  it('lets a new document enter the lists of the documents it is close to', async () => {
    await store.replaceDocument(drive.id, doc('Plans/tomatoes.docx'), [chunk(0, v({ 0: 1 }))], MODEL)
    await refreshNeighbours(pool, quiet)
    expect((await relatedPaths('Garden.md'))?.[0]).toBe('Plans/tomatoes.docx')
    expect(await relatedPaths('Plans/tomatoes.docx')).toContain('Garden.md')
  })

  it('takes a deleted document out of every list at once', async () => {
    const id = await idOf('Plans/tomatoes.docx')
    expect(await store.deleteDocuments(drive.id, ['Plans/tomatoes.docx'])).toBe(1)
    const left = await pool.query('SELECT 1 FROM document_neighbours WHERE neighbour_id = $1 OR document_id = $1', [id])
    expect(left.rowCount).toBe(0)
    expect(await relatedPaths('Garden.md')).not.toContain('Plans/tomatoes.docx')
    // The lists that lost it are refreshed next round, so their slots fill again.
    await refreshNeighbours(pool, quiet)
    expect(await relatedPaths('Garden.md')).toHaveLength(8)
  })

  it('takes a document that leaves the map out of every list', async () => {
    // Every chunk dropped by the secrets scanner: no vector, no neighbours.
    await store.replaceDocument(repo.id, doc('README.md', 'h2'), [], MODEL)
    const id = await idOf('README.md')
    const left = await pool.query('SELECT 1 FROM document_neighbours WHERE neighbour_id = $1', [id])
    expect(left.rowCount).toBe(0)
    expect(await relatedPaths('Garden.md', { repo: 'garden-app' })).toEqual([])
  })

  it('hides neighbours in a switched-off source, and answers null for a missing document', async () => {
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [drive.id])
    expect(await relatedPaths('Garden.md', { sources: ['gdrive'] })).toEqual([])
    expect(await relatedPaths('Garden.md')).not.toContain('Plans/garden.docx')
    expect(await related.related({ documentId: await idOf('Plans/garden.docx'), filters: {}, limit: 8, cutoff: 0.6 })).toBeNull()
    await pool.query('UPDATE sources SET enabled = true WHERE id = $1', [drive.id])
    expect(await related.related({ documentId: 999_999, filters: {}, limit: 8, cutoff: 0.6 })).toBeNull()
  })
})

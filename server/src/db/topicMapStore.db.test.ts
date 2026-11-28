import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createPgIndexStore, ensureSource, type ChunkWrite, type IndexStore } from './indexStore.js'
import { runMigrations } from './migrate.js'
import { dropTestDatabase } from './testDatabase.js'
import { createPgTopicMapStore, type TopicMapStore } from './topicMapStore.js'

const MODEL = 'nomic-embed-text'
const vector = (index: number): number[] => {
  const result = new Array<number>(768).fill(0)
  result[index] = 1
  return result
}
const chunk = (text: string, embedding: number[]): ChunkWrite => ({
  ordinal: 0,
  headingPath: 'Gardening',
  startLine: 1,
  endLine: 1,
  content: text,
  embedding,
})

const write = (store: IndexStore, sourceId: number, path: string, text: string, embedding: number[]) =>
  store.replaceDocument(
    sourceId,
    { path, title: path.split('/').at(-1)!.replace(/\.md$/, ''), language: null, contentHash: text, allowLlm: true, mtime: null },
    [chunk(text, embedding)],
    MODEL,
  )

const cosineVector = (similarityToZero: number): number[] => {
  const result = new Array<number>(768).fill(0)
  result[0] = similarityToZero
  result[10] = Math.sqrt(Math.max(0, 1 - similarityToZero * similarityToZero))
  return result
}

describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('topic map retrieval (R20, T73)', () => {
  const dbName = `pythia_topic_map_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool
  let store: TopicMapStore
  let keepId: number
  let vaultId: number

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
    const index = createPgIndexStore(pool)
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    const keep = await ensureSource(pool, 'keep', 'keep', '/keep')
    const repo = await ensureSource(pool, 'repo', 'garden-app', '/repo')
    vaultId = vault.id
    keepId = keep.id
    await write(index, vault.id, 'Garden.md', 'Garden soil grows tomatoes and herbs.', vector(0))
    await write(index, keep.id, 'Keep/Garden.md', 'Garden plants need healthy soil.', vector(1))
    await write(index, repo.id, 'README.md', 'Garden application setup and soil notes.', vector(2))
    await write(index, repo.id, 'src/garden.ts', 'Garden implementation source code.', vector(3))
    await write(index, vault.id, 'UnrelatedNovel.md', 'Anime space spirits battle in another world.', cosineVector(0.25))
    await index.replaceDocument(
      vault.id,
      { path: 'MultiChunkSemantic.md', title: 'MultiChunkSemantic', language: null, contentHash: 'multi', allowLlm: true, mtime: null },
      [
        chunk('Compost enriches beds across seasons.', cosineVector(0.8)),
        chunk('Mulch retains moisture around roots.', cosineVector(0.8)),
        chunk('Cover crops protect topsoil in winter.', cosineVector(0.8)),
      ],
      MODEL,
    )
    store = createPgTopicMapStore(pool)
  })

  afterAll(async () => {
    await pool?.end()
    if (admin) await dropTestDatabase(admin, dbName)
    await admin?.end()
  })

  const search = (filters: { sources?: readonly ('obsidian' | 'keep' | 'repo')[]; repo?: string } = {}) =>
    store.search({
      query: 'garden soil',
      embedding: vector(0),
      embedModel: MODEL,
      filters,
      candidates: 50,
      limit: 40,
    })

  it('returns only eligible map documents, excludes work and boilerplate by map-vector membership, and applies filters', async () => {
    const all = await search()
    expect(all.map((doc) => doc.path).sort()).toEqual(['Garden.md', 'Keep/Garden.md', 'MultiChunkSemantic.md', 'README.md'])
    expect(all[0]?.path).toBe('Garden.md')
    expect(all.every((doc) => doc.embedding.length === 768 && doc.headingPaths.length > 0 && doc.text.length > 0)).toBe(true)

    const keep = await search({ sources: ['keep'] })
    expect(keep.map((doc) => doc.sourceKind)).toEqual(['keep'])
    expect(keep[0]?.documentId).toBe(keepId)

    const repo = await search({ repo: 'garden-app' })
    expect(repo.map((doc) => doc.path)).toEqual(['README.md'])
    expect(repo[0]?.sourceKind).toBe('repo')
  })

  it('drops weak semantic matches and gates off-topic FTS hits when ftsMaxDistance is set', async () => {
    const scoped = await store.search({
      query: 'garden soil',
      embedding: vector(0),
      embedModel: MODEL,
      filters: { sources: ['obsidian'] },
      candidates: 50,
      limit: 40,
      ftsMaxDistance: 0.5,
    })
    expect(scoped.map((doc) => doc.path).sort()).toEqual(['Garden.md', 'MultiChunkSemantic.md'])
    expect(vaultId).toBeGreaterThan(0)
  })
})

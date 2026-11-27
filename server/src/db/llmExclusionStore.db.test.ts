import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import type { LlmExclusion } from '../ingest/llmExclusions.js'
import { createPgIndexStore, ensureSource } from './indexStore.js'
import { createPgLlmExclusionStore } from './llmExclusionStore.js'
import { runMigrations } from './migrate.js'
import { dropTestDatabase } from './testDatabase.js'

// T40 verify against real Postgres: migrations/009_llm_rules.sql and the
// tag, repo and Keep rules. Opt-in with PYTHIA_DB_TESTS=1.
describe.skipIf(process.env.PYTHIA_DB_TESTS !== '1')('Gemini list rules against Postgres', () => {
  const dbName = `pythia_llm_rules_test_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let pool: pg.Pool

  beforeAll(async () => {
    const db = loadConfig(process.env).db
    admin = new pg.Client({ ...db, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${dbName}"`)
    pool = new pg.Pool({ ...db, database: dbName })
    pool.on('error', () => {})
    pool.on('connect', (client) => client.on('error', () => {}))
    await runMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('DELETE FROM llm_exclusions')
    await pool.query('DELETE FROM documents')
    const store = createPgIndexStore(pool)
    const write = async (sourceId: number, path: string, allowLlm: boolean, tags: string[] = []) =>
      store.replaceDocument(
        sourceId,
        { path, title: path, language: 'markdown', contentHash: `h-${path}`, allowLlm, mtime: null, tags },
        [],
        'nomic-embed-text',
      )
    const vault = await ensureSource(pool, 'obsidian', 'vault', '/vault')
    const pythia = await ensureSource(pool, 'repo', 'pythia', '/mirrors/pythia')
    const kitchen = await ensureSource(pool, 'repo', 'kitchen', '/mirrors/kitchen')
    const keep = await ensureSource(pool, 'keep', 'keep', 'takeout')
    await write(vault.id, 'Health/log.md', true, ['private/health'])
    await write(vault.id, 'Inline.md', true, ['private'])
    await write(vault.id, 'Other.md', true, ['privateish'])
    await write(vault.id, 'Ideas.md', false)
    await write(pythia.id, 'README.md', true)
    await write(pythia.id, 'src/a.ts', true)
    await write(kitchen.id, 'README.md', true)
    await write(keep.id, 'Keep/a', true)
  })

  afterAll(async () => {
    await pool?.end()
    if (admin !== undefined) {
      await dropTestDatabase(admin, dbName)
      await admin.end()
    }
  })

  const allowLlm = async () =>
    Object.fromEntries(
      (
        await pool.query<{ key: string; allow_llm: boolean }>(
          `SELECT s.name || ':' || d.path AS key, d.allow_llm FROM documents d JOIN sources s ON s.id = d.source_id`,
        )
      ).rows.map((row) => [row.key, row.allow_llm]),
    )

  const rules: LlmExclusion[] = [
    { kind: 'tag', path: 'private' },
    { kind: 'repo', path: 'Pythia' },
    { kind: 'keep', path: 'keep' },
  ]

  it('stores tags lower case on documents and lists rules in kind order', async () => {
    const exclusions = createPgLlmExclusionStore(pool)
    await exclusions.replace([...rules].reverse())
    expect(await exclusions.list()).toEqual(rules)
    const { rows } = await pool.query<{ tags: string[] }>(`SELECT tags FROM documents WHERE path = 'Health/log.md'`)
    expect(rows[0]?.tags).toEqual(['private/health'])
  })

  it('locks tagged notes (nested too), the named repo and Keep in the same save, then counts them', async () => {
    const exclusions = createPgLlmExclusionStore(pool)
    await exclusions.replace(rules)
    expect(await allowLlm()).toEqual({
      'vault:Health/log.md': false,
      'vault:Inline.md': false,
      'vault:Other.md': true,
      'vault:Ideas.md': false,
      'pythia:README.md': false,
      'pythia:src/a.ts': false,
      'kitchen:README.md': true,
      'keep:Keep/a': false,
    })
    expect(await exclusions.countDocuments(rules)).toEqual([2, 2, 1])
    expect(await exclusions.countDocuments([{ kind: 'folder', path: 'health' }])).toEqual([1])
  })

  it('gives repos and Keep back when their rule goes, but leaves vault notes to the refresh', async () => {
    const exclusions = createPgLlmExclusionStore(pool)
    await exclusions.replace(rules)
    await exclusions.replace([])
    expect(await allowLlm()).toMatchObject({
      'pythia:README.md': true,
      'pythia:src/a.ts': true,
      'keep:Keep/a': true,
      // Only VaultIndexer.refreshAllowLlm may give these back, after reading frontmatter.
      'vault:Health/log.md': false,
      'vault:Inline.md': false,
    })
  })

  it('rejects an unknown kind and a keep rule with another path', async () => {
    await expect(pool.query(`INSERT INTO llm_exclusions (kind, path) VALUES ('secret', 'x')`)).rejects.toThrow(/check/)
    await expect(pool.query(`INSERT INTO llm_exclusions (kind, path) VALUES ('keep', 'notes')`)).rejects.toThrow(/check/)
  })
})

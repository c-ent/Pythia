import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChunkWrite, DocumentState, DocumentWrite, IndexStore } from '../db/indexStore.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { SecretsDropEvent } from '../security/secrets.js'
import { createMemoryLlmExclusionStore, type LlmExclusion } from './llmExclusions.js'
import { createVaultIndexer, isVaultNotePath, listVaultNotes, toVaultPath } from './vaultIndexer.js'

interface StoredDoc {
  doc: DocumentWrite
  chunks: ChunkWrite[]
  embedModel: string
}

/** In-memory IndexStore with the same contract as the Postgres one. */
export function memoryStore() {
  const docs = new Map<string, StoredDoc>()
  const key = (sourceId: number, relPath: string): string => `${sourceId}:${relPath}`
  const store: IndexStore = {
    async getDocumentStates(sourceId, embedModel, paths) {
      const states = new Map<string, DocumentState>()
      for (const [k, stored] of docs) {
        if (!k.startsWith(`${sourceId}:`)) continue
        if (paths !== undefined && !paths.includes(stored.doc.path)) continue
        states.set(stored.doc.path, {
          contentHash: stored.doc.contentHash,
          allowLlm: stored.doc.allowLlm,
          stale: stored.chunks.length > 0 && stored.embedModel !== embedModel,
        })
      }
      return states
    },
    async replaceDocument(sourceId, doc, chunks, embedModel) {
      docs.set(key(sourceId, doc.path), { doc: { ...doc }, chunks: [...chunks], embedModel })
    },
    async setAllowLlm(sourceId, relPath, allowLlm) {
      const stored = docs.get(key(sourceId, relPath))
      if (stored) stored.doc.allowLlm = allowLlm
    },
    async deleteDocuments(sourceId, paths) {
      let n = 0
      for (const relPath of paths) if (docs.delete(key(sourceId, relPath))) n++
      return n
    },
  }
  return { store, docs, get: (relPath: string, sourceId = 1) => docs.get(key(sourceId, relPath)) }
}

/** Counts every text sent for embedding. */
export function fakeEmbedder(model = 'nomic-embed-text'): Embedder & { texts: string[]; calls: number; fail: boolean } {
  const embedder = {
    model,
    dimensions: EMBED_DIMENSIONS,
    texts: [] as string[],
    calls: 0,
    fail: false,
    async embedDocuments(texts: readonly string[]) {
      embedder.calls++
      if (embedder.fail) throw new Error('ollama down')
      embedder.texts.push(...texts)
      return texts.map((_, i) => Array.from({ length: EMBED_DIMENSIONS }, () => i))
    },
    async embedQuery() {
      return Array.from({ length: EMBED_DIMENSIONS }, () => 0)
    },
  }
  return embedder
}

// Built at runtime so no literal secret is ever committed.
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'Z9y8X7w6V5'.repeat(4)

let root: string

async function put(relPath: string, text: string): Promise<void> {
  const abs = path.join(root, ...relPath.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, text)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pythia-vault-'))
  await put('Projects/Pythia.md', '# Goals\n\nSearch every note.\n\n## Risks\n\nNone yet.')
  await put('Private/diary.md', '# Today\n\nSecret-ish thoughts.')
  await put('Ideas.md', '---\nllm: false\n---\n# Idea\n\nKeep this local.')
  await put('Empty.md', '')
  await put('.obsidian/workspace.md', '# not a note')
  await put('.trash/old.md', '# deleted in Obsidian')
  await put('attachments/photo.png', 'binary')
  await put('Keys/credentials.md', '# blocked by name')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const PRIVATE_FOLDER: LlmExclusion = { kind: 'folder', path: 'Private' }

function setup(options: { exclusions?: LlmExclusion[] } = {}) {
  const mem = memoryStore()
  const embedder = fakeEmbedder()
  const drops: SecretsDropEvent[] = []
  const exclusions = createMemoryLlmExclusionStore(options.exclusions ?? [PRIVATE_FOLDER])
  const indexer = createVaultIndexer({
    root,
    sourceId: 1,
    store: mem.store,
    embedder,
    exclusions: () => exclusions.list(),
    logSecrets: (event) => drops.push(event),
  })
  return { mem, embedder, indexer, drops, exclusions }
}

const allowLlmOf = (mem: ReturnType<typeof memoryStore>) =>
  Object.fromEntries([...mem.docs.values()].map((stored) => [stored.doc.path, stored.doc.allowLlm]))

describe('vault paths', () => {
  it.each([
    ['Notes/a.md', true],
    ['A.MD', true],
    ['.obsidian/x.md', false],
    ['Notes/.hidden.md', false],
    ['image.png', false],
    ['credentials.md', false],
    ['../escape.md', false],
  ])('isVaultNotePath(%s) -> %s', (relPath, expected) => {
    expect(isVaultNotePath(relPath)).toBe(expected)
  })

  it('maps absolute paths into the vault and rejects outside ones', () => {
    expect(toVaultPath(root, path.join(root, 'a', 'b.md'))).toBe('a/b.md')
    expect(toVaultPath(root, root)).toBe('')
    expect(toVaultPath(root, path.join(root, '..', 'other.md'))).toBeNull()
  })

  it('lists only indexable notes, sorted', async () => {
    expect(await listVaultNotes(root)).toEqual(['Empty.md', 'Ideas.md', 'Private/diary.md', 'Projects/Pythia.md'])
  })
})

describe('createVaultIndexer', () => {
  it('indexes notes with chunks, hashes, titles and allow_llm', async () => {
    const { mem, embedder, indexer } = setup()
    const result = await indexer.fullScan()
    expect(result.indexed.sort()).toEqual(['Empty.md', 'Ideas.md', 'Private/diary.md', 'Projects/Pythia.md'])
    expect(result.failed).toEqual([])

    const pythia = mem.get('Projects/Pythia.md')
    expect(pythia?.doc).toMatchObject({ title: 'Pythia', language: 'markdown', allowLlm: true })
    expect(pythia?.doc.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(pythia?.embedModel).toBe('nomic-embed-text')
    expect(pythia?.chunks.length).toBeGreaterThan(0)
    expect(pythia?.chunks.every((chunk) => chunk.embedding.length === EMBED_DIMENSIONS)).toBe(true)
    expect(pythia?.chunks.map((chunk) => chunk.ordinal)).toEqual(pythia?.chunks.map((_, i) => i))

    expect(mem.get('Private/diary.md')?.doc.allowLlm).toBe(false)
    expect(mem.get('Ideas.md')?.doc.allowLlm).toBe(false)
    // An empty note is stored (so it is not re-read every scan) with no chunks.
    expect(mem.get('Empty.md')?.chunks).toEqual([])
    expect(embedder.texts.every((text) => !text.includes('not a note'))).toBe(true)
    expect(mem.docs.size).toBe(4)
  })

  it('skips Ollama for every unchanged note on the second run', async () => {
    const { embedder, indexer } = setup()
    await indexer.fullScan()
    const callsAfterFirst = embedder.calls
    expect(callsAfterFirst).toBeGreaterThan(0)

    const second = await indexer.fullScan()
    expect(second).toMatchObject({ indexed: [], unchanged: 4, deleted: [], failed: [] })
    expect(embedder.calls).toBe(callsAfterFirst)
  })

  it('re-embeds only the note that changed', async () => {
    const { embedder, indexer, mem } = setup()
    await indexer.fullScan()
    embedder.texts.length = 0
    await put('Projects/Pythia.md', '# Goals\n\nSearch every note, fast.')
    const result = await indexer.fullScan()
    expect(result.indexed).toEqual(['Projects/Pythia.md'])
    expect(result.unchanged).toBe(3)
    expect(embedder.texts.join('\n')).toContain('fast')
    expect(mem.get('Projects/Pythia.md')?.chunks).toHaveLength(1)
  })

  it('removes a deleted file from the index', async () => {
    const { indexer, mem } = setup()
    await indexer.fullScan()
    await unlink(path.join(root, 'Ideas.md'))
    const result = await indexer.fullScan()
    expect(result.deleted).toEqual(['Ideas.md'])
    expect(mem.get('Ideas.md')).toBeUndefined()
    expect(mem.docs.size).toBe(3)
  })

  it('keeps the index when the vault folder is suddenly empty', async () => {
    const { indexer, mem } = setup()
    await indexer.fullScan()
    await rm(root, { recursive: true, force: true })
    await mkdir(root)
    const result = await indexer.fullScan()
    expect(result.keptEmptyVault).toBe(true)
    expect(result.deleted).toEqual([])
    expect(mem.docs.size).toBe(4)
  })

  it('fails without deleting anything when the vault folder is missing', async () => {
    const { indexer, mem } = setup()
    await indexer.fullScan()
    await rm(root, { recursive: true, force: true })
    await expect(indexer.fullScan()).rejects.toThrow(/ENOENT/)
    expect(mem.docs.size).toBe(4)
  })

  it('drops chunks with secrets before embedding and logs only the count', async () => {
    const { embedder, indexer, mem, drops } = setup()
    await put(
      'Setup.md',
      `# Install\n\nRun pnpm install.\n\n# Token\n\nMy token is ${FAKE_GITHUB_TOKEN} for now.`,
    )
    await indexer.fullScan()
    expect(drops).toEqual([{ file: 'Setup.md', droppedCount: 1 }])
    expect(embedder.texts.join('\n')).not.toContain(FAKE_GITHUB_TOKEN)
    const setupDoc = mem.get('Setup.md')
    expect(setupDoc?.chunks.map((chunk) => chunk.headingPath)).toEqual(['Setup > Install'])
    expect(JSON.stringify([...mem.docs.values()])).not.toContain(FAKE_GITHUB_TOKEN)
  })

  it('keeps the old chunks when embedding fails and retries on the next scan', async () => {
    const { embedder, indexer, mem } = setup()
    await indexer.fullScan()
    const before = mem.get('Projects/Pythia.md')
    await put('Projects/Pythia.md', '# Goals\n\nChanged while Ollama is down.')
    embedder.fail = true
    const failed = await indexer.fullScan()
    expect(failed.failed).toEqual([{ path: 'Projects/Pythia.md', error: 'ollama down' }])
    expect(mem.get('Projects/Pythia.md')).toEqual(before)

    embedder.fail = false
    const retried = await indexer.fullScan()
    expect(retried.indexed).toEqual(['Projects/Pythia.md'])
  })

  it('updates allow_llm without re-embedding when the list changes between scans', async () => {
    const { indexer, mem, embedder, exclusions } = setup()
    await indexer.fullScan()
    const calls = embedder.calls
    await exclusions.replace([])
    const result = await indexer.fullScan()
    expect(result).toMatchObject({ indexed: [], unchanged: 4 })
    expect(mem.get('Private/diary.md')?.doc.allowLlm).toBe(true)
    expect(embedder.calls).toBe(calls)
  })

  it('re-embeds notes stored with another embedding model', async () => {
    const { indexer, mem } = setup()
    await indexer.fullScan()
    const other = fakeEmbedder('other-embed')
    const reindexer = createVaultIndexer({ root, sourceId: 1, store: mem.store, embedder: other })
    const result = await reindexer.fullScan()
    // Empty.md has no chunks, so there is nothing stale to re-embed.
    expect(result.indexed.sort()).toEqual(['Ideas.md', 'Private/diary.md', 'Projects/Pythia.md'])
    expect(mem.get('Ideas.md')?.embedModel).toBe('other-embed')
  })

  it('syncPaths indexes present files, deletes missing ones and ignores others', async () => {
    const { indexer, mem, embedder } = setup()
    await indexer.fullScan()
    await put('New.md', '# New\n\nFresh note.')
    await unlink(path.join(root, 'Ideas.md'))
    embedder.calls = 0
    const result = await indexer.syncPaths(['New.md', 'Ideas.md', '.obsidian/workspace.md', 'Never.md', 'New.md'])
    expect(result.indexed).toEqual(['New.md'])
    expect(result.deleted).toEqual(['Ideas.md'])
    expect(embedder.calls).toBe(1)
    expect(mem.get('New.md')).toBeDefined()
    expect(mem.get('Ideas.md')).toBeUndefined()
  })

  it('runs scans one at a time', async () => {
    const { indexer, embedder } = setup()
    const [a, b] = await Promise.all([indexer.fullScan(), indexer.fullScan()])
    expect(a.indexed).toHaveLength(4)
    expect(b).toMatchObject({ indexed: [], unchanged: 4 })
    expect(embedder.calls).toBe(3)
  })
})

// T24: the Gemini exclusion list replaces the hard-coded Private/ default.
describe('Gemini exclusion list', () => {
  it('starts empty, so Private/ is no longer kept away by default', async () => {
    const { indexer, mem } = setup({ exclusions: [] })
    await indexer.fullScan()
    expect(allowLlmOf(mem)).toEqual({
      'Empty.md': true,
      'Ideas.md': false,
      'Private/diary.md': true,
      'Projects/Pythia.md': true,
    })
  })

  it('keeps every note in an excluded folder away, ignoring case', async () => {
    await put('Projects/Deep/plan.md', '# Plan\n\nNested.')
    await put('ProjectsArchive/old.md', '# Old\n\nSimilar name, different folder.')
    const { indexer, mem } = setup({ exclusions: [{ kind: 'folder', path: 'projects' }] })
    await indexer.fullScan()
    expect(mem.get('Projects/Pythia.md')?.doc.allowLlm).toBe(false)
    expect(mem.get('Projects/Deep/plan.md')?.doc.allowLlm).toBe(false)
    expect(mem.get('ProjectsArchive/old.md')?.doc.allowLlm).toBe(true)
    expect(mem.get('Private/diary.md')?.doc.allowLlm).toBe(true)
  })

  it('keeps a single excluded note away and leaves its neighbours alone', async () => {
    await put('Projects/Other.md', '# Other\n\nStill allowed.')
    const { indexer, mem } = setup({ exclusions: [{ kind: 'note', path: 'Projects/Pythia.md' }] })
    await indexer.fullScan()
    expect(mem.get('Projects/Pythia.md')?.doc.allowLlm).toBe(false)
    expect(mem.get('Projects/Other.md')?.doc.allowLlm).toBe(true)
  })

  it('applies the list to notes picked up by the watcher (syncPaths)', async () => {
    const { indexer, mem } = setup({ exclusions: [{ kind: 'note', path: 'New.md' }] })
    await put('New.md', '# New\n\nFresh note.')
    await indexer.syncPaths(['New.md'])
    expect(mem.get('New.md')?.doc.allowLlm).toBe(false)
  })

  it('still keeps an llm: false note away when the list is empty or does not mention it', async () => {
    const { indexer, mem, exclusions } = setup({ exclusions: [] })
    await indexer.fullScan()
    expect(mem.get('Ideas.md')?.doc.allowLlm).toBe(false)
    await exclusions.replace([{ kind: 'folder', path: 'Private' }])
    await indexer.refreshAllowLlm()
    await exclusions.replace([])
    await indexer.refreshAllowLlm()
    expect(mem.get('Ideas.md')?.doc.allowLlm).toBe(false)
  })

  it('applies a changed list without embedding or rewriting any note', async () => {
    const { indexer, mem, embedder, exclusions } = setup({ exclusions: [] })
    await indexer.fullScan()
    const before = structuredClone([...mem.docs.values()].map((stored) => stored.chunks))
    const calls = embedder.calls
    const replaceDocument = vi.spyOn(mem.store, 'replaceDocument')
    const deleteDocuments = vi.spyOn(mem.store, 'deleteDocuments')

    await exclusions.replace([
      { kind: 'folder', path: 'Private' },
      { kind: 'note', path: 'Projects/Pythia.md' },
    ])
    expect(await indexer.refreshAllowLlm()).toEqual({ updated: 2 })
    expect(allowLlmOf(mem)).toMatchObject({ 'Private/diary.md': false, 'Projects/Pythia.md': false, 'Empty.md': true })

    // Removing the entries gives the notes back, again without re-processing.
    await exclusions.replace([])
    expect(await indexer.refreshAllowLlm()).toEqual({ updated: 2 })
    expect(allowLlmOf(mem)).toMatchObject({ 'Private/diary.md': true, 'Projects/Pythia.md': true, 'Ideas.md': false })

    expect(embedder.calls).toBe(calls)
    expect(replaceDocument).not.toHaveBeenCalled()
    expect(deleteDocuments).not.toHaveBeenCalled()
    expect([...mem.docs.values()].map((stored) => stored.chunks)).toEqual(before)
  })

  it('a later full scan after a list change embeds nothing either', async () => {
    const { indexer, embedder, exclusions } = setup({ exclusions: [] })
    await indexer.fullScan()
    const calls = embedder.calls
    await exclusions.replace([{ kind: 'folder', path: 'Projects' }])
    expect(await indexer.fullScan()).toMatchObject({ indexed: [], unchanged: 4, deleted: [] })
    expect(embedder.calls).toBe(calls)
  })

  it('refresh leaves a note that changed on disk to the next sync, unless it is listed', async () => {
    const { indexer, mem, exclusions } = setup({ exclusions: [{ kind: 'folder', path: 'Private' }] })
    await indexer.fullScan()
    // Edited to remove llm: false, but not synced yet: refresh must not trust the new text.
    await put('Ideas.md', '# Idea\n\nNow shareable.')
    await put('Private/diary.md', '# Today\n\nEdited.')
    await exclusions.replace([])
    await indexer.refreshAllowLlm()
    expect(mem.get('Ideas.md')?.doc.allowLlm).toBe(false)
    expect(mem.get('Private/diary.md')?.doc.allowLlm).toBe(false)

    await exclusions.replace([{ kind: 'note', path: 'Projects/Pythia.md' }])
    await put('Projects/Pythia.md', '# Goals\n\nEdited too.')
    await indexer.refreshAllowLlm()
    expect(mem.get('Projects/Pythia.md')?.doc.allowLlm).toBe(false)
  })

  it('refresh never deletes a note whose file is gone', async () => {
    const { indexer, mem, exclusions } = setup({ exclusions: [] })
    await indexer.fullScan()
    await unlink(path.join(root, 'Projects', 'Pythia.md'))
    await exclusions.replace([{ kind: 'folder', path: 'Private' }])
    await indexer.refreshAllowLlm()
    expect(mem.get('Projects/Pythia.md')).toBeDefined()
    expect(mem.get('Private/diary.md')?.doc.allowLlm).toBe(false)
  })
})

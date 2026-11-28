import { describe, expect, it } from 'vitest'
import type { ChunkWrite, DocumentState, DocumentWrite, IndexStore } from '../db/indexStore.js'
import type { SourceStatusRow } from '../db/statusStore.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { SecretsDropEvent } from '../security/secrets.js'
import { createImportService } from './importService.js'
import { createKeepImporter } from './keepImporter.js'
import { KeepTakeoutError, parseKeepTakeout } from './keepTakeout.js'
import { linksKey } from './links.js'
import type { LlmExclusion } from './llmExclusions.js'
import { keepJson, takeoutZip } from './testKeepTakeout.js'

/** In-memory IndexStore with the same contract as the Postgres one. */
function memoryStore() {
  const docs = new Map<string, { doc: DocumentWrite; chunks: ChunkWrite[]; embedModel: string }>()
  const allowLlmCalls: { path: string; allowLlm: boolean }[] = []
  let failWrites = false
  const store: IndexStore = {
    async getDocumentStates(_sourceId, embedModel) {
      const states = new Map<string, DocumentState>()
      for (const stored of docs.values()) {
        states.set(stored.doc.path, {
          contentHash: stored.doc.contentHash,
          allowLlm: stored.doc.allowLlm,
          stale: stored.chunks.length > 0 && stored.embedModel !== embedModel,
          linksKey: linksKey(stored.doc.links ?? []),
        })
      }
      return states
    },
    async replaceLinks(_sourceId, path, links) {
      const stored = docs.get(path)
      if (stored !== undefined) stored.doc.links = [...links]
    },
    async replaceDocument(_sourceId, doc, chunks, embedModel) {
      if (failWrites) throw new Error('db down')
      docs.set(doc.path, { doc: { ...doc }, chunks: [...chunks], embedModel })
    },
    async setAllowLlm(_sourceId, path, allowLlm) {
      allowLlmCalls.push({ path, allowLlm })
      const stored = docs.get(path)
      if (stored !== undefined) stored.doc.allowLlm = allowLlm
    },
    async deleteDocuments(_sourceId, paths) {
      let n = 0
      for (const path of paths) if (docs.delete(path)) n++
      return n
    },
  }
  return {
    store,
    docs,
    allowLlmCalls,
    failWrites: (value: boolean) => {
      failWrites = value
    },
  }
}

function fakeEmbedder(): Embedder & { texts: string[]; fail: boolean } {
  const embedder = {
    model: 'nomic-embed-text',
    dimensions: EMBED_DIMENSIONS,
    texts: [] as string[],
    fail: false,
    async embedDocuments(texts: readonly string[]) {
      if (embedder.fail) throw new Error('ollama down')
      embedder.texts.push(...texts)
      return texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, () => 0.1))
    },
    async embedQuery() {
      return Array.from({ length: EMBED_DIMENSIONS }, () => 0)
    },
  }
  return embedder
}

// Built at runtime so no literal secret is ever committed.
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'Q1w2E3r4T5'.repeat(4)

function setup(rules: { list: LlmExclusion[] } = { list: [] }) {
  const mem = memoryStore()
  const embedder = fakeEmbedder()
  const secrets: SecretsDropEvent[] = []
  const importer = createKeepImporter({
    sourceId: 5,
    store: mem.store,
    embedder,
    exclusions: async () => rules.list,
    logSecrets: (event) => secrets.push(event),
  })
  const importZip = (entries: Record<string, Uint8Array | string>) => importer.importNotes(parseKeepTakeout(takeoutZip(entries)))
  return { ...mem, embedder, secrets, importZip }
}

describe('Keep importer', () => {
  it('stores every note with allow_llm = true, its title and searchable checklist and labels', async () => {
    const { docs, importZip } = setup()
    const result = await importZip({
      'Groceries.json': keepJson({ labels: [{ name: 'home' }] }),
      'Packing.json': keepJson({
        title: '',
        textContent: undefined,
        listContent: [{ text: 'Passport', isChecked: true }],
      }),
    })
    expect(result).toMatchObject({ notes: 2, indexed: 2, unchanged: 0, deleted: 0, failed: 0 })
    const groceries = docs.get('Keep/Groceries')
    expect(groceries?.doc).toMatchObject({ title: 'Groceries', allowLlm: true, language: 'markdown' })
    expect(groceries?.doc.mtime?.getTime()).toBe(1_732_000_000_000)
    expect(groceries?.chunks.map((chunk) => chunk.content).join('\n')).toBe('Buy oat milk\n\nLabels: home')
    expect(groceries?.chunks[0]?.headingPath).toBe('Groceries')
    const packing = docs.get('Keep/Packing')
    expect(packing?.doc).toMatchObject({ title: 'Passport', allowLlm: true })
    expect(packing?.chunks[0]?.content).toBe('- [x] Passport')
  })

  it('re-importing flips notes stored with allow_llm = false (before T26) to true without calling Ollama', async () => {
    const { docs, embedder, allowLlmCalls, importZip } = setup()
    const zip = { 'a.json': keepJson({ title: 'A' }), 'b.json': keepJson({ title: 'B' }) }
    await importZip(zip)
    const a = docs.get('Keep/a')
    if (a !== undefined) a.doc.allowLlm = false // as T22 stored it
    const embedded = embedder.texts.length

    const again = await importZip(zip)

    expect(again).toMatchObject({ notes: 2, indexed: 0, unchanged: 2, failed: 0 })
    expect(embedder.texts.length).toBe(embedded)
    expect(allowLlmCalls).toEqual([{ path: 'Keep/a', allowLlm: true }])
    expect([...docs.values()].map((stored) => stored.doc.allowLlm)).toEqual([true, true])
  })

  it('a keep rule locks every note, and lifting it gives them back, without calling Ollama again', async () => {
    const rules = { list: [{ kind: 'keep', path: 'keep' }] as LlmExclusion[] }
    const { docs, embedder, importZip } = setup(rules)
    const zip = { 'a.json': keepJson({ title: 'A' }), 'b.json': keepJson({ title: 'B' }) }
    await importZip(zip)
    expect([...docs.values()].map((stored) => stored.doc.allowLlm)).toEqual([false, false])
    const embedded = embedder.texts.length

    rules.list = []
    expect(await importZip(zip)).toMatchObject({ indexed: 0, unchanged: 2 })
    expect([...docs.values()].map((stored) => stored.doc.allowLlm)).toEqual([true, true])
    expect(embedder.texts.length).toBe(embedded)
  })

  it('a second import of the same zip changes nothing and skips Ollama', async () => {
    const { docs, embedder, importZip } = setup()
    const zip = { 'a.json': keepJson({ title: 'A' }), 'b.json': keepJson({ title: 'B' }) }
    await importZip(zip)
    const embedded = embedder.texts.length
    const again = await importZip(zip)
    expect(again).toMatchObject({ notes: 2, indexed: 0, unchanged: 2, deleted: 0 })
    expect(embedder.texts.length).toBe(embedded)
    expect(docs.size).toBe(2)
  })

  it('replaces all Keep notes: edits are re-indexed and notes missing from the new export are deleted', async () => {
    const { docs, importZip } = setup()
    await importZip({ 'a.json': keepJson({ title: 'A' }), 'b.json': keepJson({ title: 'B' }) })
    const result = await importZip({ 'a.json': keepJson({ title: 'A', textContent: 'Edited' }), 'c.json': keepJson({ title: 'C' }) })
    expect(result).toMatchObject({ notes: 2, indexed: 2, unchanged: 0, deleted: 1 })
    expect([...docs.keys()].sort()).toEqual(['Keep/a', 'Keep/c'])
    expect(docs.get('Keep/a')?.chunks[0]?.content).toBe('Edited')
  })

  it('drops a chunk with a planted secret and logs only the count', async () => {
    const { docs, secrets, embedder, importZip } = setup()
    await importZip({ 'wifi.json': keepJson({ title: 'Tokens', textContent: `deploy token ${FAKE_GITHUB_TOKEN}` }) })
    expect(docs.get('Keep/wifi')?.chunks).toEqual([])
    expect(secrets).toEqual([{ file: 'Keep/wifi', droppedCount: 1 }])
    expect(JSON.stringify(secrets)).not.toContain(FAKE_GITHUB_TOKEN)
    expect(embedder.texts.join('\n')).not.toContain(FAKE_GITHUB_TOKEN)
  })

  it('keeps the stored note when embedding fails and retries it next time', async () => {
    const { docs, embedder, importZip } = setup()
    await importZip({ 'a.json': keepJson({ title: 'A' }) })
    embedder.fail = true
    const failed = await importZip({ 'a.json': keepJson({ title: 'A', textContent: 'New text' }) })
    expect(failed).toMatchObject({ indexed: 0, failed: 1, deleted: 0 })
    expect(docs.get('Keep/a')?.chunks[0]?.content).toBe('Buy oat milk')
    embedder.fail = false
    const retried = await importZip({ 'a.json': keepJson({ title: 'A', textContent: 'New text' }) })
    expect(retried).toMatchObject({ indexed: 1, failed: 0 })
  })
})

describe('import service', () => {
  const status: SourceStatusRow[] = [
    { kind: 'keep', name: 'keep', enabled: true, documents: 2, chunks: 2, updatedAt: new Date('2026-11-26T00:00:00Z') },
  ]

  function service(options: { enabled?: boolean; reindexers?: Parameters<typeof createImportService>[0]['reindexers'] } = {}) {
    const mem = memoryStore()
    const sourceCalls: number[] = []
    const svc = createImportService({
      status: { listSources: async () => status },
      keepSource: async () => {
        sourceCalls.push(1)
        return { id: 5, enabled: options.enabled ?? true }
      },
      store: mem.store,
      embedder: fakeEmbedder(),
      reindexers: options.reindexers,
      log: () => {},
    })
    return { svc, mem, sourceCalls }
  }

  it('rejects a non-Keep upload without touching the stored notes', async () => {
    const { svc, mem, sourceCalls } = service()
    await svc.importKeep(takeoutZip({ 'a.json': keepJson() }))
    await expect(svc.importKeep(new TextEncoder().encode('not a zip'))).rejects.toBeInstanceOf(KeepTakeoutError)
    await expect(
      svc.importKeep(takeoutZip({ '/Takeout/Drive/x.json': JSON.stringify({ name: 'x' }) })),
    ).rejects.toThrow('No Google Keep notes found')
    expect(mem.docs.size).toBe(1)
    expect(sourceCalls).toHaveLength(1)
  })

  it('refuses an export whose notes are all trashed, so it cannot wipe Keep', async () => {
    const { svc, mem } = service()
    await svc.importKeep(takeoutZip({ 'a.json': keepJson() }))
    await expect(svc.importKeep(takeoutZip({ 'a.json': keepJson({ isTrashed: true }) }))).rejects.toThrow('no notes to import')
    expect(mem.docs.size).toBe(1)
  })

  it('does not import into a disabled Keep source', async () => {
    const { svc, mem } = service({ enabled: false })
    await expect(svc.importKeep(takeoutZip({ 'a.json': keepJson() }))).rejects.toThrow('switched off')
    expect(mem.docs.size).toBe(0)
  })

  it('reports index status and which re-index tasks exist', async () => {
    const { svc } = service({ reindexers: { vault: async () => {} } })
    expect(await svc.status()).toEqual({ sources: status, reindex: { vault: 'idle', repos: 'off' } })
  })

  it('starts each re-index once at a time and reports it as running', async () => {
    let finish: () => void = () => {}
    let runs = 0
    const vault = () => {
      runs++
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    }
    const { svc } = service({ reindexers: { vault, repos: async () => {} } })
    expect(svc.reindex()).toEqual({ vault: 'running', repos: 'running' })
    expect(svc.reindex().vault).toBe('running')
    expect(runs).toBe(1)
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await svc.status()).reindex).toEqual({ vault: 'idle', repos: 'idle' })
  })

  it('survives a failing re-index', async () => {
    const { svc } = service({ reindexers: { repos: async () => Promise.reject(new Error('fetch failed')) } })
    svc.reindex()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await svc.status()).reindex.repos).toBe('idle')
  })
})

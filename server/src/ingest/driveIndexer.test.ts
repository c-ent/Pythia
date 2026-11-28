import { mkdtemp, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChunkWrite, DocumentState, DocumentWrite, IndexStore } from '../db/indexStore.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { SecretsDropEvent } from '../security/secrets.js'
import type { OfficeConverter } from './driveConvert.js'
import { createDriveIndexer, isDriveFilePath, listDriveFiles } from './driveIndexer.js'
import type { LlmExclusion } from './llmExclusions.js'
import { docxFile, ENCRYPTED_OFFICE_BYTES, pdfFile, PNG_BYTES, pptxFile, xlsxFile } from './testDriveFiles.js'

interface StoredDoc {
  doc: DocumentWrite
  chunks: ChunkWrite[]
  embedModel: string
}

/** In-memory IndexStore with the same contract as the Postgres one. */
function memoryStore() {
  const docs = new Map<string, StoredDoc>()
  const store: IndexStore = {
    async getDocumentStates(_sourceId, embedModel, paths) {
      const states = new Map<string, DocumentState>()
      for (const stored of docs.values()) {
        if (paths !== undefined && !paths.includes(stored.doc.path)) continue
        states.set(stored.doc.path, {
          contentHash: stored.doc.contentHash,
          allowLlm: stored.doc.allowLlm,
          stale: stored.chunks.length > 0 && stored.embedModel !== embedModel,
        })
      }
      return states
    },
    async replaceDocument(_sourceId, doc, chunks, embedModel) {
      docs.set(doc.path, { doc: { ...doc }, chunks: [...chunks], embedModel })
    },
    async replaceLinks() {},
    async setAllowLlm(_sourceId, relPath, allowLlm) {
      const stored = docs.get(relPath)
      if (stored) stored.doc.allowLlm = allowLlm
    },
    async deleteDocuments(_sourceId, paths) {
      let n = 0
      for (const relPath of paths) if (docs.delete(relPath)) n++
      return n
    },
  }
  return { store, docs }
}

function fakeEmbedder(): Embedder & { texts: string[]; calls: number; fail: boolean } {
  const embedder = {
    model: 'nomic-embed-text',
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
let xlsx: Uint8Array

const put = async (relPath: string, bytes: Uint8Array | string): Promise<void> => {
  const abs = path.join(root, ...relPath.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
}

beforeAll(async () => {
  xlsx = await xlsxFile([{ name: 'Budget', rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300]] }])
})

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pythia-gdrive-'))
  await put('Work/Minutes.docx', docxFile([{ heading: 1, text: 'Decisions' }, { paragraph: 'Ship the beta.' }]))
  await put('Work/Budget.xlsx', xlsx)
  await put('Work/Kickoff.pptx', pptxFile([{ title: 'Goals', body: ['Grow the team'], notes: ['Say thanks'] }]))
  await put('Papers/Report.pdf', pdfFile([['First page text'], ['Second page text']]))
  await put('Old/Letter.doc', new Uint8Array([1, 2, 3]))
  await put('Notes/todo.md', '# Todo\n\nCall the bank.')
  await put('Notes/plain.txt', 'Just a line of text.')
  await put('Photos/cat.png', PNG_BYTES)
  await put('Locked.docx', ENCRYPTED_OFFICE_BYTES)
  await put('.hidden/x.md', '# not read')
  await put('Keys/credentials.txt', 'blocked by name')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Stand-in for LibreOffice: every `.doc` becomes this `.docx`. */
const stubConverter = (): OfficeConverter & ReturnType<typeof vi.fn> =>
  vi.fn(() =>
    Promise.resolve(docxFile([{ heading: 1, text: 'Dear Ana' }, { paragraph: 'Old letter text.' }])),
  ) as unknown as OfficeConverter & ReturnType<typeof vi.fn>

function setup(converter: OfficeConverter = stubConverter()) {
  const mem = memoryStore()
  const embedder = fakeEmbedder()
  const drops: SecretsDropEvent[] = []
  const indexer = createDriveIndexer({
    root,
    sourceId: 7,
    store: mem.store,
    embedder,
    converter,
    logSecrets: (event) => drops.push(event),
  })
  return { mem, embedder, indexer, drops, converter }
}

describe('drive paths', () => {
  it.each([
    ['Work/Minutes.docx', true],
    ['Photos/cat.png', true],
    ['.hidden/x.md', false],
    ['Work/.~lock.docx#', false],
    ['../escape.docx', false],
    ['Keys/credentials.txt', false],
    ['id_rsa', false],
  ])('isDriveFilePath(%s) -> %s', (relPath, expected) => {
    expect(isDriveFilePath(relPath)).toBe(expected)
  })

  it('lists every non-hidden, non-blocked file, sorted', async () => {
    expect(await listDriveFiles(root)).toEqual([
      'Locked.docx',
      'Notes/plain.txt',
      'Notes/todo.md',
      'Old/Letter.doc',
      'Papers/Report.pdf',
      'Photos/cat.png',
      'Work/Budget.xlsx',
      'Work/Kickoff.pptx',
      'Work/Minutes.docx',
    ])
  })
})

describe('createDriveIndexer', () => {
  it('indexes every document format with scoped headings and counts the skipped files', async () => {
    const { mem, indexer, embedder } = setup()
    const result = await indexer.fullScan()
    expect(result.failed).toEqual([])
    expect(result.files).toBe(9)
    expect(result.indexed.sort()).toEqual([
      'Notes/plain.txt',
      'Notes/todo.md',
      'Old/Letter.doc',
      'Papers/Report.pdf',
      'Work/Budget.xlsx',
      'Work/Kickoff.pptx',
      'Work/Minutes.docx',
    ])
    expect(result.skipped).toEqual({ not_document: 1, empty: 0, encrypted: 1, unreadable: 0, conversion_failed: 0 })

    const headings = (relPath: string) => mem.docs.get(relPath)?.chunks.map((chunk) => chunk.headingPath)
    expect(headings('Work/Minutes.docx')).toEqual(['Minutes > Decisions'])
    expect(headings('Work/Budget.xlsx')).toEqual(['Budget > Budget'])
    expect(headings('Work/Kickoff.pptx')).toEqual(['Kickoff > Goals'])
    expect(headings('Papers/Report.pdf')).toEqual(['Report > Page 1', 'Report > Page 2'])
    expect(headings('Old/Letter.doc')).toEqual(['Letter > Dear Ana'])
    expect(mem.docs.get('Work/Kickoff.pptx')?.chunks[0]?.content).toContain('Say thanks')

    const minutes = mem.docs.get('Work/Minutes.docx')
    expect(minutes?.doc).toMatchObject({ title: 'Minutes', language: null, allowLlm: true })
    expect(minutes?.doc.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(minutes?.embedModel).toBe('nomic-embed-text')
    expect(mem.docs.get('Notes/todo.md')?.doc.language).toBe('markdown')
    expect([...mem.docs.values()].every((stored) => stored.doc.allowLlm)).toBe(true)
    expect(
      [...mem.docs.values()].every((stored) => stored.chunks.every((c) => c.embedding.length === EMBED_DIMENSIONS)),
    ).toBe(true)
    expect(embedder.texts.some((text) => text.includes('Grow the team'))).toBe(true)
  })

  it('skips Ollama and the converter on the second run', async () => {
    const { indexer, embedder, converter } = setup()
    await indexer.fullScan()
    const calls = embedder.calls
    const result = await indexer.fullScan()
    expect(result).toMatchObject({ indexed: [], unchanged: 7, deleted: [], failed: [] })
    // Skipped files are counted again without being read twice.
    expect(result.skipped.not_document + result.skipped.encrypted).toBe(2)
    expect(embedder.calls).toBe(calls)
    expect(converter).toHaveBeenCalledTimes(1)
  })

  it('re-indexes a changed file only', async () => {
    const { indexer, embedder } = setup()
    await indexer.fullScan()
    embedder.texts.length = 0
    await put('Notes/todo.md', '# Todo\n\nCall the bank and the dentist.')
    const result = await indexer.fullScan()
    expect(result.indexed).toEqual(['Notes/todo.md'])
    expect(result.unchanged).toBe(6)
    expect(embedder.texts.join('\n')).toContain('dentist')
  })

  it('deletes documents whose files left the mirror', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    await unlink(path.join(root, 'Work', 'Budget.xlsx'))
    await rm(path.join(root, 'Papers'), { recursive: true })
    const result = await indexer.fullScan()
    expect(result.deleted).toEqual(['Papers/Report.pdf', 'Work/Budget.xlsx'])
    expect(mem.docs.has('Work/Budget.xlsx')).toBe(false)
    expect(mem.docs.size).toBe(5)
  })

  it('removes a stored document that is no longer readable', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    await put('Work/Minutes.docx', ENCRYPTED_OFFICE_BYTES)
    const result = await indexer.fullScan()
    expect(result.deleted).toEqual(['Work/Minutes.docx'])
    expect(result.skipped.encrypted).toBe(2)
    expect(mem.docs.has('Work/Minutes.docx')).toBe(false)
  })

  it('keeps the index when the mirror is empty', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    for (const entry of await readdir(root)) await rm(path.join(root, entry), { recursive: true })
    const result = await indexer.fullScan()
    expect(result).toMatchObject({ files: 0, keptEmptyMirror: true, deleted: [] })
    expect(mem.docs.size).toBe(7)
  })

  it('rejects and deletes nothing when the mirror is missing', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    await rm(root, { recursive: true })
    await expect(indexer.fullScan()).rejects.toThrow()
    expect(mem.docs.size).toBe(7)
  })

  it('drops a chunk with a planted key and logs only the count', async () => {
    await put(
      'Work/Setup.docx',
      docxFile([
        { heading: 1, text: 'Intro' },
        { paragraph: 'Welcome to the project.' },
        { heading: 1, text: 'Access' },
        { paragraph: `token ${FAKE_GITHUB_TOKEN}` },
      ]),
    )
    const { mem, indexer, embedder, drops } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await indexer.fullScan()
    warn.mockRestore()
    const stored = mem.docs.get('Work/Setup.docx')
    expect(stored?.chunks.map((chunk) => chunk.headingPath)).toEqual(['Setup > Intro'])
    expect(drops).toEqual([{ file: 'Work/Setup.docx', droppedCount: 1 }])
    expect(JSON.stringify(drops)).not.toContain(FAKE_GITHUB_TOKEN)
    expect(embedder.texts.join('\n')).not.toContain(FAKE_GITHUB_TOKEN)
    expect(JSON.stringify([...mem.docs.values()])).not.toContain(FAKE_GITHUB_TOKEN)
  })

  it('indexes a large document in full', async () => {
    const paragraphs = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} about the archive, marker-${i}.`)
    await put('Archive/Big.txt', paragraphs.join('\n\n'))
    const { mem, indexer } = setup()
    const result = await indexer.fullScan()
    expect(result.indexed).toContain('Archive/Big.txt')
    const text = mem.docs.get('Archive/Big.txt')!.chunks.map((chunk) => chunk.content).join('\n')
    expect(mem.docs.get('Archive/Big.txt')!.chunks.length).toBeGreaterThan(20)
    for (const i of [0, 1999, 3999]) expect(text).toContain(`marker-${i}.`)
  })

  it('counts a failed conversion as skipped and tries again once the file changes', async () => {
    const converter = vi.fn(() => Promise.reject(new Error('soffice timed out'))) as unknown as OfficeConverter
    const { mem, indexer } = setup(converter)
    const first = await indexer.fullScan()
    expect(first.skipped.conversion_failed).toBe(1)
    expect(mem.docs.has('Old/Letter.doc')).toBe(false)
    await indexer.fullScan()
    expect(converter).toHaveBeenCalledTimes(1)
    await put('Old/Letter.doc', new Uint8Array([4, 5, 6]))
    await indexer.fullScan()
    expect(converter).toHaveBeenCalledTimes(2)
  })

  it('keeps the stored chunks when Ollama fails and retries next round', async () => {
    const { mem, indexer, embedder } = setup()
    await indexer.fullScan()
    const before = mem.docs.get('Notes/todo.md')!.chunks
    await put('Notes/todo.md', '# Todo\n\nSomething new.')
    embedder.fail = true
    const failed = await indexer.fullScan()
    expect(failed.failed.map((failure) => failure.path)).toEqual(['Notes/todo.md'])
    expect(mem.docs.get('Notes/todo.md')!.chunks).toEqual(before)
    embedder.fail = false
    expect((await indexer.fullScan()).indexed).toEqual(['Notes/todo.md'])
  })

  it('never indexes an excluded folder and removes it when it was indexed before', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    expect(mem.docs.has('Work/Minutes.docx')).toBe(true)
    const result = await indexer.fullScan({ exclude: ['Work'] })
    expect(result.deleted).toEqual(['Work/Budget.xlsx', 'Work/Kickoff.pptx', 'Work/Minutes.docx'])
    expect([...mem.docs.keys()].some((relPath) => relPath.startsWith('Work/'))).toBe(false)
    expect(mem.docs.has('Notes/todo.md')).toBe(true)
    // `Workshop` is not inside `Work`.
    await put('Workshop/plan.md', '# Plan\n\nTables.')
    expect((await indexer.fullScan({ exclude: ['Work'] })).indexed).toEqual(['Workshop/plan.md'])
  })

  it('removes an excluded folder even when nothing else is left in the mirror', async () => {
    const { mem, indexer } = setup()
    await indexer.fullScan()
    for (const entry of await readdir(root)) if (entry !== 'Work') await rm(path.join(root, entry), { recursive: true })
    const result = await indexer.fullScan({ exclude: ['Work'] })
    expect(result.keptEmptyMirror).toBe(true)
    expect(result.deleted).toEqual(['Work/Budget.xlsx', 'Work/Kickoff.pptx', 'Work/Minutes.docx'])
    expect(mem.docs.size).toBe(4)
  })

  describe('Drive Gemini rules (T62)', () => {
    function setupWithRules(rules: LlmExclusion[]) {
      const mem = memoryStore()
      const embedder = fakeEmbedder()
      const indexer = createDriveIndexer({
        root,
        sourceId: 7,
        store: mem.store,
        embedder,
        converter: stubConverter(),
        logSecrets: () => {},
        exclusions: async () => rules,
      })
      const allow = () => Object.fromEntries([...mem.docs].map(([relPath, stored]) => [relPath, stored.doc.allowLlm]))
      return { mem, embedder, indexer, allow }
    }

    it('locks a folder and its subfolders, ignoring case, and leaves the rest allowed', async () => {
      await put('Work/Deep/inner.md', '# Inner\n\nNested text.')
      const { indexer, allow } = setupWithRules([{ kind: 'gdrive', path: 'work' }])
      await indexer.fullScan()
      expect(allow()).toMatchObject({
        'Work/Minutes.docx': false,
        'Work/Budget.xlsx': false,
        'Work/Deep/inner.md': false,
        'Notes/todo.md': true,
        'Papers/Report.pdf': true,
      })
    })

    it('applies a rule added or removed later without calling Ollama', async () => {
      const rules: LlmExclusion[] = []
      const { indexer, embedder, allow } = setupWithRules(rules)
      await indexer.fullScan()
      const calls = embedder.calls
      rules.push({ kind: 'gdrive', path: '/' })
      expect((await indexer.fullScan()).indexed).toEqual([])
      expect(Object.values(allow()).every((value) => value === false)).toBe(true)
      rules.length = 0
      await indexer.fullScan()
      expect(Object.values(allow()).every((value) => value === true)).toBe(true)
      expect(embedder.calls).toBe(calls)
    })

    it('keeps frontmatter llm: false on a Markdown file when its folder is unlocked', async () => {
      await put('Notes/private.md', '---\nllm: false\n---\n# Private\n\nNot for Gemini.')
      const rules: LlmExclusion[] = [{ kind: 'gdrive', path: 'Notes' }]
      const { indexer, allow } = setupWithRules(rules)
      await indexer.fullScan()
      rules.length = 0
      await indexer.fullScan()
      expect(allow()).toMatchObject({ 'Notes/private.md': false, 'Notes/todo.md': true })
    })
  })

  it('never writes to the mirror', async () => {
    const snapshot = async () => {
      const entries = (await readdir(root, { recursive: true })).sort()
      return Promise.all(
        entries.map(async (entry) => [entry, await readFile(path.join(root, entry)).catch(() => 'dir')] as const),
      )
    }
    const before = await snapshot()
    const { indexer } = setup()
    await indexer.fullScan()
    expect(await snapshot()).toEqual(before)
  })
})

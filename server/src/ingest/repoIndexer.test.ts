import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChunkWrite, DocumentState, DocumentWrite, IndexStore } from '../db/indexStore.js'
import { EMBED_DIMENSIONS, type Embedder } from '../embed/ollama.js'
import type { SecretsDropEvent } from '../security/secrets.js'
import type { RepoSpec } from './repoConfig.js'
import { indexRepoCommit, SUMMARY_PATH, type RepoIndexerOptions } from './repoIndexer.js'
import { mirrorPath, syncRepo } from './repoMirror.js'

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', windowsHide: true })
}

async function put(root: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

// Built at runtime so no literal secret is ever committed.
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'Q1w2E3r4T5'.repeat(4)

interface StoredDoc {
  doc: DocumentWrite
  chunks: ChunkWrite[]
  embedModel: string
}

/** In-memory IndexStore with the same contract as the Postgres one, for one source. */
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
    async setAllowLlm(_sourceId, docPath, allowLlm) {
      const stored = docs.get(docPath)
      if (stored) stored.doc.allowLlm = allowLlm
    },
    async deleteDocuments(_sourceId, paths) {
      let n = 0
      for (const docPath of paths) if (docs.delete(docPath)) n++
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
      return texts.map(() => Array.from({ length: EMBED_DIMENSIONS }, () => 0.1))
    },
    async embedQuery() {
      return Array.from({ length: EMBED_DIMENSIONS }, () => 0)
    },
  }
  return embedder
}

let work: string
let source: string
let mirrors: string
let spec: RepoSpec

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'pythia-repoindex-'))
  source = path.join(work, 'source')
  mirrors = path.join(work, 'mirrors')
  await mkdir(source)
  git(source, 'init', '--quiet', '--initial-branch=main')
  await put(source, 'README.md', '# Kitchen app\n\nPlans weekly meals and builds a shopping list.\n\n## Usage\n\nRun it.\n')
  await put(source, 'package.json', '{"name":"kitchen","dependencies":{"zod":"^4.0.0"}}\n')
  await put(source, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  await put(
    source,
    'src/planner.ts',
    'export function planMeals(days: number): string[] {\n  return Array.from({ length: days }, () => "soup")\n}\n',
  )
  await put(source, 'src/shopping.py', 'def shopping_list(meals):\n    return sorted(set(meals))\n')
  await put(source, 'src/config.ts', `export const githubToken = '${FAKE_GITHUB_TOKEN}'\n`)
  await put(source, 'src/data.ts', Buffer.from([0x65, 0x78, 0, 0, 0x70]))
  await put(source, '.env', 'PLACEHOLDER=1\n')
  await put(source, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  git(source, 'add', '--all', '--force')
  git(source, 'commit', '--quiet', '-m', 'first')
  spec = { name: 'kitchen', url: source, branch: null }
}, 60_000)

afterEach(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5 })
})

async function setup(extra: Partial<RepoIndexerOptions> = {}) {
  const { store, docs } = memoryStore()
  const embedder = fakeEmbedder()
  const secrets: SecretsDropEvent[] = []
  const options: RepoIndexerOptions = {
    repo: 'kitchen',
    branch: null,
    dir: mirrorPath(mirrors, 'kitchen'),
    sourceId: 1,
    store,
    embedder,
    mirror: { mirrorsDir: mirrors },
    logSecrets: (event) => secrets.push(event),
    ...extra,
  }
  const index = async () => indexRepoCommit(options, (await syncRepo(spec, { mirrorsDir: mirrors })).commit)
  return { docs, embedder, secrets, index, options }
}

describe('indexRepoCommit', () => {
  it('indexes allowlisted files and one SUMMARY document', async () => {
    const { docs, index } = await setup()
    const result = await index()

    expect(result.failed).toEqual([])
    expect([...docs.keys()].sort()).toEqual(
      [SUMMARY_PATH, 'README.md', 'package.json', 'src/config.ts', 'src/planner.ts', 'src/shopping.py'].sort(),
    )
    expect(result.skipped.binary).toBe(1)
    expect(result.skipped.lockfile).toBe(1)
    expect(result.skipped.blocked).toBe(1)
    expect(result.skipped['ignored-directory']).toBe(1)

    const planner = docs.get('src/planner.ts')
    expect(planner?.doc.language).toBe('typescript')
    expect(planner?.doc.allowLlm).toBe(true)
    expect(planner?.chunks.some((chunk) => chunk.content.includes('planMeals'))).toBe(true)
    expect(planner?.chunks.every((chunk) => chunk.embedding.length === EMBED_DIMENSIONS)).toBe(true)

    const summary = docs.get(SUMMARY_PATH)
    expect(summary?.chunks).toHaveLength(1)
    expect(summary?.chunks[0]?.headingPath).toBe('SUMMARY > kitchen')
    expect(summary?.chunks[0]?.content).toContain('Plans weekly meals')
    expect(summary?.chunks[0]?.content).toContain('zod')
    expect(summary?.chunks[0]?.content).toContain('Indexed files: 5')
    expect(summary?.chunks[0]?.content).toContain('python (1)')
    expect(result.summary).toBe('indexed')
  }, 60_000)

  it('never stores, embeds or logs a planted secret', async () => {
    const { docs, embedder, secrets, index } = await setup()
    await index()

    const stored = [...docs.values()].flatMap((doc) => doc.chunks.map((chunk) => chunk.content))
    expect(stored.some((content) => content.includes(FAKE_GITHUB_TOKEN))).toBe(false)
    expect(embedder.texts.some((text) => text.includes(FAKE_GITHUB_TOKEN))).toBe(false)
    expect(secrets).toEqual([{ file: 'src/config.ts', droppedCount: 1 }])
    expect(JSON.stringify(secrets)).not.toContain(FAKE_GITHUB_TOKEN)
  }, 60_000)

  it('a locked repo gets allow_llm = false everywhere, and unlocking flips it back without Ollama', async () => {
    const { docs, embedder, index, options } = await setup({ allowLlm: false })
    await index()
    expect([...docs.values()].every((stored) => !stored.doc.allowLlm)).toBe(true)
    const calls = embedder.calls

    options.allowLlm = true
    const second = await index()
    expect(second.indexed).toEqual([])
    expect(embedder.calls).toBe(calls)
    expect([...docs.values()].every((stored) => stored.doc.allowLlm)).toBe(true)
    expect(docs.get(SUMMARY_PATH)?.doc.allowLlm).toBe(true)
  }, 60_000)

  it('skips Ollama for an unchanged commit', async () => {
    const { embedder, index } = await setup()
    await index()
    const calls = embedder.calls
    const second = await index()
    expect(embedder.calls).toBe(calls)
    expect(second.indexed).toEqual([])
    expect(second.deleted).toEqual([])
    expect(second.summary).toBe('unchanged')
    // Five files; the SUMMARY document is counted separately.
    expect(second.unchanged).toBe(5)
  }, 60_000)

  it('re-indexes changed files and deletes removed ones', async () => {
    const { docs, index } = await setup()
    await index()

    await put(source, 'src/planner.ts', 'export function planMeals(): string[] {\n  return ["curry"]\n}\n')
    await unlink(path.join(source, 'src/shopping.py'))
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'second')
    const result = await index()

    expect(result.indexed).toEqual(['src/planner.ts'])
    expect(result.deleted).toEqual(['src/shopping.py'])
    expect(docs.has('src/shopping.py')).toBe(false)
    expect(docs.get('src/planner.ts')?.chunks.some((chunk) => chunk.content.includes('curry'))).toBe(true)
    // The file list changed, so the overview did too.
    expect(result.summary).toBe('indexed')
    expect(docs.get(SUMMARY_PATH)?.chunks[0]?.content).not.toContain('python')
  }, 60_000)

  it('keeps the previous chunks when embedding fails', async () => {
    const { docs, embedder, index } = await setup()
    await index()
    const before = docs.get('src/planner.ts')

    await put(source, 'src/planner.ts', 'export function planMeals(): string[] {\n  return ["stew"]\n}\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'third')
    embedder.fail = true
    const result = await index()

    expect(result.failed.map((failure) => failure.path)).toContain('src/planner.ts')
    expect(result.deleted).toEqual([])
    expect(docs.get('src/planner.ts')).toEqual(before)

    // The next round retries and succeeds.
    embedder.fail = false
    const retry = await index()
    expect(retry.indexed).toEqual(['src/planner.ts'])
    expect(docs.get('src/planner.ts')?.chunks.some((chunk) => chunk.content.includes('stew'))).toBe(true)
  }, 60_000)

  it('prefixes README chunks with the repo name for "which repo has X?" queries', async () => {
    const { docs, embedder, index } = await setup()
    await index()
    expect(docs.get('README.md')?.chunks.length).toBeGreaterThan(0)
    expect(embedder.texts.some((text) => text.startsWith('kitchen: ') && text.includes('shopping list'))).toBe(true)
  }, 60_000)
})

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentState, IndexStore } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { dropSecretChunks, isBlockedPath, logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'
import { extractLinks, linksKey } from './links.js'
import { isExcludedFromLlm, type LlmExclusion } from './llmExclusions.js'
import { chunkMarkdown, noteFrontmatter, noteLlmMeta, type MarkdownChunk } from './markdownChunker.js'

/** Stored tags (absent before T40) against the note's tags; both sorted. */
const sameTags = (stored: readonly string[] | undefined, current: readonly string[]): boolean =>
  (stored ?? []).length === current.length && (stored ?? []).every((tag, i) => tag === current[i])

export interface VaultIndexerOptions {
  /** Absolute path of the vault on disk. Read only; nothing is ever written there. */
  root: string
  sourceId: number
  store: IndexStore
  embedder: Embedder
  /**
   * The Gemini exclusion list (R3), read at the start of every scan, sync and
   * refresh. Notes it excludes get `allow_llm = false`. Absent means empty.
   */
  exclusions?: () => Promise<readonly LlmExclusion[]>
  logSecrets?: SecretsDropLogger
}

export interface IndexFailure {
  path: string
  error: string
}

export interface IndexResult {
  /** Notes (re-)embedded and written. */
  indexed: string[]
  /** Notes whose hash matched; only `allow_llm` may have been updated. */
  unchanged: number
  deleted: string[]
  /** Left as they were in the database; retried on the next scan. */
  failed: IndexFailure[]
  /** Set when a scan found no notes and kept the existing index rather than delete it. */
  keptEmptyVault?: boolean
}

export interface RefreshResult {
  /** Notes whose `allow_llm` was changed. */
  updated: number
}

export interface VaultIndexer {
  /** Indexes every note and deletes documents whose files are gone. */
  fullScan(): Promise<IndexResult>
  /** Re-checks the given vault-relative paths: indexes those on disk, deletes the rest. */
  syncPaths(paths: readonly string[]): Promise<IndexResult>
  /**
   * Re-applies the exclusion list and frontmatter to every stored note's
   * `allow_llm`. Never embeds, never rewrites chunks and never deletes: a note
   * that changed on disk or cannot be read is left to the next sync, except
   * that a listed note always gets `false`.
   */
  refreshAllowLlm(): Promise<RefreshResult>
  /** Live progress during a full scan, or null when idle. */
  progress?(): { stage: string; done: number | null; total: number | null } | null
}

const MARKDOWN = /\.md$/i

/**
 * True for a vault-relative path the indexer reads: a `.md` file that is not
 * inside a dot folder (`.obsidian`, `.trash`, `.git`) and not on the secrets
 * blocklist.
 */
export function isVaultNotePath(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '..' || segment.startsWith('.'))) return false
  return MARKDOWN.test(relPath) && !isBlockedPath(relPath)
}

/** Vault-relative `/` path for an absolute path, `''` for the root, or null when outside the vault. */
export function toVaultPath(root: string, absPath: string): string | null {
  const rel = path.relative(root, absPath)
  if (rel === '') return ''
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null
  return rel.split(path.sep).join('/')
}

/** Every note path in the vault, sorted. Symlinks are not followed, so indexing stays inside the vault. */
export async function listVaultNotes(root: string): Promise<string[]> {
  const notes: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel)
      else if (entry.isFile() && isVaultNotePath(childRel)) notes.push(childRel)
    }
  }
  await walk(root, '')
  return notes.sort()
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createVaultIndexer(options: VaultIndexerOptions): VaultIndexer {
  const { root, sourceId, store, embedder } = options
  const loadExclusions = options.exclusions ?? (async () => [])
  const logSecrets = options.logSecrets ?? logSecretsDrop
  // One scan, sync or refresh at a time, so the watcher, a periodic rescan and
  // a Settings change never write the same note concurrently.
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  const emptyResult = (): IndexResult => ({ indexed: [], unchanged: 0, deleted: [], failed: [] })
  const notePath = (relPath: string): string => path.join(root, ...relPath.split('/'))
  let currentProgress: { stage: string; done: number | null; total: number | null } | null = null

  /** Throws ENOENT when the file is gone. */
  async function indexNote(
    relPath: string,
    state: DocumentState | undefined,
    exclusions: readonly LlmExclusion[],
  ): Promise<'indexed' | 'unchanged'> {
    const absPath = notePath(relPath)
    const [bytes, info] = await Promise.all([readFile(absPath), stat(absPath)])
    const contentHash = sha256(bytes)
    const markdown = bytes.toString('utf8')
    const note = chunkMarkdown(relPath, markdown)
    // Frontmatter `llm: false` and the exclusion list (paths and tags) each keep a note away on their own.
    const allowLlm = note.allowLlm && !isExcludedFromLlm(relPath, exclusions, note.tags)
    // The embedded text includes the heading path, so scan that rather than the body alone.
    const cleanChunks = (log: SecretsDropLogger): MarkdownChunk[] =>
      dropSecretChunks(
        relPath,
        note.chunks.map((chunk) => ({ chunk, content: chunk.embedText })),
        log,
      ).map(({ chunk }) => chunk)
    // Links (R20) come only from the chunks that will be stored, never from dropped text.
    const linksOf = (chunks: readonly MarkdownChunk[]) =>
      extractLinks({ yaml: noteFrontmatter(markdown), contents: chunks.map((chunk) => chunk.content) })

    if (state !== undefined && state.contentHash === contentHash && !state.stale) {
      // Same text, but the list may have changed, or the tags were never stored (before T40).
      if (state.allowLlm !== allowLlm || !sameTags(state.tags, note.tags)) {
        await store.setAllowLlm(sourceId, relPath, allowLlm, note.tags)
      }
      // Links stored before T68 (none) or by an older parser are rewritten without re-embedding.
      // The drop was logged when the note was indexed; it is not logged again on every scan.
      if (state.linksKey !== undefined) {
        const links = linksOf(cleanChunks(() => {}))
        if (linksKey(links) !== state.linksKey) await store.replaceLinks(sourceId, relPath, links)
      }
      return 'unchanged'
    }

    const clean = cleanChunks(logSecrets)
    // Embed before touching the database: if Ollama fails, the old chunks stay.
    const embeddings = clean.length > 0 ? await embedder.embedDocuments(clean.map((chunk) => chunk.embedText)) : []

    await store.replaceDocument(
      sourceId,
      {
        path: relPath,
        title: note.title,
        language: 'markdown',
        contentHash,
        allowLlm,
        mtime: info.mtime,
        tags: note.tags,
        links: linksOf(clean),
      },
      clean.map((chunk, i) => ({
        ordinal: i,
        headingPath: chunk.headingPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        embedding: embeddings[i] ?? [],
      })),
      embedder.model,
    )
    return 'indexed'
  }

  async function indexAll(
    paths: readonly string[],
    states: Map<string, DocumentState>,
    exclusions: readonly LlmExclusion[],
    result: IndexResult,
    missing: string[],
    trackProgress = false,
  ): Promise<void> {
    let done = 0
    for (const relPath of paths) {
      if (trackProgress) currentProgress = { stage: 'indexing', done, total: paths.length }
      try {
        const outcome = await indexNote(relPath, states.get(relPath), exclusions)
        if (outcome === 'indexed') result.indexed.push(relPath)
        else result.unchanged++
      } catch (error) {
        if (isMissing(error)) missing.push(relPath)
        else result.failed.push({ path: relPath, error: messageOf(error) })
      }
      done++
    }
  }

  async function deleteKnown(paths: readonly string[], states: Map<string, DocumentState>, result: IndexResult) {
    const known = paths.filter((relPath) => states.has(relPath))
    if (known.length === 0) return
    await store.deleteDocuments(sourceId, known)
    result.deleted.push(...known)
  }

  /** Frontmatter `allow_llm` and tags from the current file, or null when it changed on disk or cannot be read. */
  async function metaFromDisk(relPath: string, state: DocumentState): Promise<{ allowLlm: boolean; tags: string[] } | null> {
    try {
      const bytes = await readFile(notePath(relPath))
      if (sha256(bytes) !== state.contentHash) return null
      return noteLlmMeta(bytes.toString('utf8'))
    } catch {
      return null
    }
  }

  return {
    progress: () => currentProgress,
    fullScan: () =>
      serialize(async () => {
        currentProgress = { stage: 'scanning', done: null, total: null }
        try {
          const result = emptyResult()
          // Throws when the vault folder is missing, before anything is deleted.
          const notes = await listVaultNotes(root)
          const exclusions = await loadExclusions()
          const states = await store.getDocumentStates(sourceId, embedder.model)
          const missing: string[] = []
          await indexAll(notes, states, exclusions, result, missing, true)

          const onDisk = new Set(notes)
          const gone = [...states.keys()].filter((relPath) => !onDisk.has(relPath)).concat(missing)
          // An empty folder usually means the sync or mount is not there yet,
          // not that every note was deleted. Keep the index and say so.
          if (notes.length === 0 && states.size > 0) {
            result.keptEmptyVault = true
            return result
          }
          await deleteKnown(gone, states, result)
          return result
        } finally {
          currentProgress = null
        }
      }),

    syncPaths: (paths) =>
      serialize(async () => {
        const result = emptyResult()
        const notes = [...new Set(paths)].filter(isVaultNotePath).sort()
        if (notes.length === 0) return result
        const exclusions = await loadExclusions()
        const states = await store.getDocumentStates(sourceId, embedder.model, notes)
        const missing: string[] = []
        await indexAll(notes, states, exclusions, result, missing)
        await deleteKnown(missing, states, result)
        return result
      }),

    refreshAllowLlm: () =>
      serialize(async () => {
        const exclusions = await loadExclusions()
        const states = await store.getDocumentStates(sourceId, embedder.model)
        let updated = 0
        for (const [relPath, state] of states) {
          // A note listed by path or by its stored tags needs no file read: it is kept away whatever it says.
          if (isExcludedFromLlm(relPath, exclusions, state.tags ?? [])) {
            if (state.allowLlm) {
              await store.setAllowLlm(sourceId, relPath, false)
              updated++
            }
            continue
          }
          const meta = await metaFromDisk(relPath, state)
          if (meta === null) continue
          const allowLlm = meta.allowLlm && !isExcludedFromLlm(relPath, exclusions, meta.tags)
          if (allowLlm === state.allowLlm && sameTags(state.tags, meta.tags)) continue
          await store.setAllowLlm(sourceId, relPath, allowLlm, meta.tags)
          if (allowLlm !== state.allowLlm) updated++
        }
        return { updated }
      }),
  }
}

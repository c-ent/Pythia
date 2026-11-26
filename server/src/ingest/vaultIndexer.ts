import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentState, IndexStore } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { dropSecretChunks, isBlockedPath, logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'
import { isExcludedFromLlm, type LlmExclusion } from './llmExclusions.js'
import { chunkMarkdown, frontmatterAllowsLlm } from './markdownChunker.js'

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

  /** Throws ENOENT when the file is gone. */
  async function indexNote(
    relPath: string,
    state: DocumentState | undefined,
    exclusions: readonly LlmExclusion[],
  ): Promise<'indexed' | 'unchanged'> {
    const absPath = notePath(relPath)
    const [bytes, info] = await Promise.all([readFile(absPath), stat(absPath)])
    const contentHash = sha256(bytes)
    const note = chunkMarkdown(relPath, bytes.toString('utf8'))
    // Frontmatter `llm: false` and the exclusion list each keep a note away on their own.
    const allowLlm = note.allowLlm && !isExcludedFromLlm(relPath, exclusions)

    if (state !== undefined && state.contentHash === contentHash && !state.stale) {
      // Same text, but the exclusion list may have changed.
      if (state.allowLlm !== allowLlm) await store.setAllowLlm(sourceId, relPath, allowLlm)
      return 'unchanged'
    }

    // The embedded text includes the heading path, so scan that rather than the body alone.
    const clean = dropSecretChunks(
      relPath,
      note.chunks.map((chunk) => ({ chunk, content: chunk.embedText })),
      logSecrets,
    ).map(({ chunk }) => chunk)
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
  ): Promise<void> {
    for (const relPath of paths) {
      try {
        const outcome = await indexNote(relPath, states.get(relPath), exclusions)
        if (outcome === 'indexed') result.indexed.push(relPath)
        else result.unchanged++
      } catch (error) {
        if (isMissing(error)) missing.push(relPath)
        else result.failed.push({ path: relPath, error: messageOf(error) })
      }
    }
  }

  async function deleteKnown(paths: readonly string[], states: Map<string, DocumentState>, result: IndexResult) {
    const known = paths.filter((relPath) => states.has(relPath))
    if (known.length === 0) return
    await store.deleteDocuments(sourceId, known)
    result.deleted.push(...known)
  }

  /** The note's `allow_llm` from its current file, or null when it changed on disk or cannot be read. */
  async function allowLlmFromDisk(relPath: string, state: DocumentState): Promise<boolean | null> {
    try {
      const bytes = await readFile(notePath(relPath))
      if (sha256(bytes) !== state.contentHash) return null
      return frontmatterAllowsLlm(bytes.toString('utf8'))
    } catch {
      return null
    }
  }

  return {
    fullScan: () =>
      serialize(async () => {
        const result = emptyResult()
        // Throws when the vault folder is missing, before anything is deleted.
        const notes = await listVaultNotes(root)
        const exclusions = await loadExclusions()
        const states = await store.getDocumentStates(sourceId, embedder.model)
        const missing: string[] = []
        await indexAll(notes, states, exclusions, result, missing)

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
          // A listed note needs no file read: it is kept away whatever it says.
          const allowLlm = isExcludedFromLlm(relPath, exclusions) ? false : await allowLlmFromDisk(relPath, state)
          if (allowLlm === null || allowLlm === state.allowLlm) continue
          await store.setAllowLlm(sourceId, relPath, allowLlm)
          updated++
        }
        return { updated }
      }),
  }
}

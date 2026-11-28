import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DocumentState, IndexStore } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { dropSecretChunks, isBlockedPath, logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'
import { extractDriveFileConverted, type OfficeConverter } from './driveConvert.js'
import { driveExtension, type DriveDocument, type DriveExtractOptions, type DriveSkipReason } from './driveExtract.js'
import { isDriveLocked, type LlmExclusion } from './llmExclusions.js'

/**
 * Indexes the read-only Drive mirror (R19, T60). The mirror is written only by
 * `rclone sync`; this module reads it and never writes there. Same pipeline as
 * the vault: blocklist, content-hash skip, secrets scan before embedding,
 * deletes for files gone from the mirror, and an empty mirror deletes nothing.
 */

export interface DriveIndexerOptions {
  /** Absolute path of the mirror (`/data/gdrive`). Read only. */
  root: string
  sourceId: number
  store: IndexStore
  embedder: Embedder
  /** Converts old Office and OpenDocument files (T64). */
  converter: OfficeConverter
  logSecrets?: SecretsDropLogger
  /** Chunk sizes; the R3 defaults when absent. */
  extract?: DriveExtractOptions
  /** The Gemini list (R16); its `gdrive` rules lock folders or the whole Drive (T62). None when absent. */
  exclusions?: () => Promise<readonly LlmExclusion[]>
}

export interface DriveIndexFailure {
  path: string
  error: string
}

export type DriveSkipCounts = Record<DriveSkipReason, number>

export interface DriveIndexResult {
  /** Files in the mirror the indexer looked at (blocked and dot paths excluded). */
  files: number
  /** Documents (re-)embedded and written. */
  indexed: string[]
  /** Documents whose bytes matched the stored copy; Ollama was not called. */
  unchanged: number
  deleted: string[]
  /** Left as they were in the database; retried on the next round. */
  failed: DriveIndexFailure[]
  /** Files that are not indexed, by reason. Counts only, never content. */
  skipped: DriveSkipCounts
  /** Set when the mirror held no files and the existing index was kept rather than deleted. */
  keptEmptyMirror?: boolean
}

export interface DriveScanOptions {
  /**
   * Drive-relative folders on the `exclude` list (`/config/gdrive.json`).
   * Their files are never indexed, and documents already stored under them
   * are deleted, even when the rest of the mirror is empty.
   */
  exclude?: readonly string[]
}

export interface DriveIndexer {
  /** Indexes every document in the mirror and deletes documents whose files are gone. */
  fullScan(options?: DriveScanOptions): Promise<DriveIndexResult>
  /** Live progress during a full scan, or null when idle. */
  progress?(): { stage: string; done: number | null; total: number | null } | null
}

/** True when the path is an excluded folder or inside one. Case-sensitive, like rclone's filters. */
export function isDriveExcluded(relPath: string, exclude: readonly string[]): boolean {
  return exclude.some((folder) => relPath === folder || relPath.startsWith(`${folder}/`))
}

export const emptySkipCounts = (): DriveSkipCounts => ({
  not_document: 0,
  empty: 0,
  encrypted: 0,
  unreadable: 0,
  conversion_failed: 0,
})

/**
 * True for a mirror-relative path the indexer looks at: not inside a dot
 * folder, not a dot file, no `..`, and not on the secrets blocklist.
 */
export function isDriveFilePath(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '..' || segment.startsWith('.'))) return false
  return !isBlockedPath(relPath)
}

/** Every file in the mirror the indexer looks at, sorted. Symlinks are not followed. Throws when the mirror is missing. */
export async function listDriveFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel)
      else if (entry.isFile() && isDriveFilePath(childRel)) files.push(childRel)
    }
  }
  await walk(root, '')
  return files.sort()
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Outcome = { kind: 'indexed' } | { kind: 'unchanged' } | { kind: 'skipped'; reason: DriveSkipReason }

export function createDriveIndexer(options: DriveIndexerOptions): DriveIndexer {
  const { root, sourceId, store, embedder, converter } = options
  const logSecrets = options.logSecrets ?? logSecretsDrop
  const extractOptions = options.extract ?? {}
  // A skipped file is not stored, so without this every round would extract
  // (and convert) it again. Keyed by path, holding the hash it was skipped at;
  // a restart forgets it and tries once more.
  const skippedAt = new Map<string, { hash: string; reason: DriveSkipReason }>()
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  const filePath = (relPath: string): string => path.join(root, ...relPath.split('/'))

  async function write(
    relPath: string,
    document: DriveDocument,
    contentHash: string,
    mtime: Date,
    locked: boolean,
  ): Promise<void> {
    // The embedded text includes the heading path, so scan that rather than the content alone.
    const clean = dropSecretChunks(
      relPath,
      document.chunks.map((chunk) => ({ chunk, content: chunk.embedText })),
      logSecrets,
    ).map(({ chunk }) => chunk)
    // Embed before touching the database: if Ollama fails, the old chunks stay.
    const embeddings = clean.length > 0 ? await embedder.embedDocuments(clean.map((chunk) => chunk.embedText)) : []
    await store.replaceDocument(
      sourceId,
      {
        path: relPath,
        title: document.title,
        language: driveExtension(relPath) === '.md' ? 'markdown' : null,
        contentHash,
        // Drive documents may reach Gemini (owner decision) unless a Drive rule
        // covers them (T62) or Markdown frontmatter says `llm: false`.
        allowLlm: document.allowLlm && !locked,
        mtime,
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
  }

  /** Throws ENOENT when the file is gone. */
  async function indexFile(
    relPath: string,
    state: DocumentState | undefined,
    exclusions: readonly LlmExclusion[],
  ): Promise<Outcome> {
    const absPath = filePath(relPath)
    const [bytes, info] = await Promise.all([readFile(absPath), stat(absPath)])
    const contentHash = sha256(bytes)
    const locked = isDriveLocked(relPath, exclusions)
    if (state !== undefined && state.contentHash === contentHash && !state.stale) {
      // Bring the flag in line with the Drive rules without re-embedding.
      const allowLlm = locked ? false : await unlockedAllowLlm(relPath, bytes)
      if (state.allowLlm !== allowLlm) await store.setAllowLlm(sourceId, relPath, allowLlm)
      return { kind: 'unchanged' }
    }

    const known = skippedAt.get(relPath)
    if (known !== undefined && known.hash === contentHash) return { kind: 'skipped', reason: known.reason }

    const extraction = await extractDriveFileConverted(relPath, new Uint8Array(bytes), {
      ...extractOptions,
      converter,
    })
    if (extraction.kind === 'skipped') {
      skippedAt.set(relPath, { hash: contentHash, reason: extraction.reason })
      return { kind: 'skipped', reason: extraction.reason }
    }
    skippedAt.delete(relPath)
    await write(relPath, extraction.document, contentHash, info.mtime, locked)
    return { kind: 'indexed' }
  }

  /**
   * `allow_llm` for an unchanged document no Drive rule covers: true, except a
   * Markdown file whose frontmatter says `llm: false` (re-read here, no
   * embedding; other formats have no such opt-out).
   */
  async function unlockedAllowLlm(relPath: string, bytes: Uint8Array): Promise<boolean> {
    if (driveExtension(relPath) !== '.md') return true
    const extraction = await extractDriveFileConverted(relPath, new Uint8Array(bytes), { ...extractOptions, converter })
    return extraction.kind !== 'document' || extraction.document.allowLlm
  }

  let currentProgress: { stage: string; done: number | null; total: number | null } | null = null

  return {
    progress: () => currentProgress,
    fullScan: (scan = {}) =>
      serialize(async () => {
        currentProgress = { stage: 'scanning', done: null, total: null }
        try {
          const exclude = scan.exclude ?? []
          // Throws when the mirror folder is missing, before anything is deleted.
          const files = (await listDriveFiles(root)).filter((relPath) => !isDriveExcluded(relPath, exclude))
          const states = await store.getDocumentStates(sourceId, embedder.model)
          const exclusions = (await options.exclusions?.()) ?? []
          const result: DriveIndexResult = {
            files: files.length,
            indexed: [],
            unchanged: 0,
            deleted: [],
            failed: [],
            skipped: emptySkipCounts(),
          }
          // A folder the owner put on the exclude list leaves the index at once.
          const excluded = [...states.keys()].filter((relPath) => isDriveExcluded(relPath, exclude)).sort()
          if (excluded.length > 0) {
            await store.deleteDocuments(sourceId, excluded)
            result.deleted.push(...excluded)
            for (const relPath of excluded) states.delete(relPath)
          }
          // An empty mirror usually means the pull or the volume is not there
          // yet, not that the whole Drive was emptied. Keep the index and say so.
          if (files.length === 0 && states.size > 0) {
            result.keptEmptyMirror = true
            return result
          }

          const gone: string[] = []
          let done = 0
          for (const relPath of files) {
            currentProgress = { stage: 'indexing', done, total: files.length }
            try {
              const outcome = await indexFile(relPath, states.get(relPath), exclusions)
              if (outcome.kind === 'indexed') result.indexed.push(relPath)
              else if (outcome.kind === 'unchanged') result.unchanged++
              else {
                result.skipped[outcome.reason]++
                // A stored document that is no longer a readable document leaves the index.
                if (states.has(relPath)) gone.push(relPath)
              }
            } catch (error) {
              if (isMissing(error)) gone.push(relPath)
              else result.failed.push({ path: relPath, error: messageOf(error) })
            }
            done++
          }

          const inMirror = new Set(files)
          for (const relPath of states.keys()) if (!inMirror.has(relPath)) gone.push(relPath)
          for (const relPath of skippedAt.keys()) if (!inMirror.has(relPath)) skippedAt.delete(relPath)
          const known = [...new Set(gone)].filter((relPath) => states.has(relPath)).sort()
          if (known.length > 0) {
            await store.deleteDocuments(sourceId, known)
            result.deleted.push(...known)
          }
          result.deleted.sort()
          return result
        } finally {
          currentProgress = null
        }
      }),
  }
}

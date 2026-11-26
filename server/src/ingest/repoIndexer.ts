import { createHash } from 'node:crypto'
import path from 'node:path'
import type { IndexStore } from '../db/indexStore.js'
import { SUMMARY_PATH } from '../db/repoStore.js'
import type { Embedder } from '../embed/ollama.js'
import { dropSecretChunks, logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'
import { chunkCode } from './codeChunker.js'
import { chunkMarkdown } from './markdownChunker.js'
import { looksBinary, selectRepoFiles, type IncludedRepoFile, type SkipReason } from './repoFilter.js'
import { listTree, readBlob, readGitignores, type MirrorOptions, type MirrorTreeFile } from './repoMirror.js'
import { buildRepoSummary } from './repoSummary.js'

// A tracked file at exactly `SUMMARY_PATH` is left out of the index, so it
// can never overwrite the repo's overview.
export { SUMMARY_PATH }

export interface RepoIndexerOptions {
  /** Source name from the repo config. */
  repo: string
  branch: string | null
  /** The repo's bare mirror. Read only. */
  dir: string
  sourceId: number
  store: IndexStore
  embedder: Embedder
  mirror: MirrorOptions
  logSecrets?: SecretsDropLogger
}

export interface RepoIndexFailure {
  path: string
  error: string
}

export interface RepoIndexResult {
  commit: string
  /** Files (re-)embedded and written. */
  indexed: string[]
  /** Files whose blob id matched the stored one. */
  unchanged: number
  deleted: string[]
  /** Left as they were in the database; retried on the next round. */
  failed: RepoIndexFailure[]
  /** Counts per skip rule, binaries included; never paths. */
  skipped: Record<SkipReason, number>
  summary: 'indexed' | 'unchanged' | 'failed'
}

type RepoFile = IncludedRepoFile<MirrorTreeFile>

interface PendingChunk {
  headingPath: string
  startLine: number
  endLine: number
  content: string
  embedText: string
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Root README and manifests feed the `SUMMARY` chunk, so their text is read every round. */
const isSummaryInput = (file: RepoFile): boolean =>
  !file.path.includes('/') && (file.kind === 'readme' || file.kind === 'manifest')

async function chunkFile(repo: string, file: RepoFile, text: string): Promise<PendingChunk[]> {
  if (file.kind === 'readme' && file.language === 'markdown') {
    // Headings split a README better than line windows; the repo name keeps
    // "which repo has X?" answerable from any of its chunks.
    return chunkMarkdown(file.path, text).chunks.map((chunk) => ({ ...chunk, embedText: `${repo}: ${chunk.embedText}` }))
  }
  return (await chunkCode({ repo, path: file.path, language: file.language, content: text })).chunks
}

/**
 * Indexes one commit of a mirrored repo. Unchanged files are recognised by
 * their blob id and never re-read or re-embedded; files gone from the commit
 * are deleted; a file that fails keeps its previous chunks. Every chunk goes
 * through the secrets scanner before it is embedded or stored.
 */
export async function indexRepoCommit(options: RepoIndexerOptions, commit: string): Promise<RepoIndexResult> {
  const { repo, dir, sourceId, store, embedder, mirror } = options
  const logSecrets = options.logSecrets ?? logSecretsDrop

  const tree = (await listTree(dir, commit, mirror)).filter((file) => file.path !== SUMMARY_PATH)
  const selection = selectRepoFiles(tree, await readGitignores(dir, tree, mirror))
  const states = await store.getDocumentStates(sourceId, embedder.model)
  const result: RepoIndexResult = {
    commit,
    indexed: [],
    unchanged: 0,
    deleted: [],
    failed: [],
    skipped: { ...selection.skipped },
    summary: 'unchanged',
  }

  async function write(docPath: string, title: string, language: string | null, hash: string, chunks: PendingChunk[]) {
    const clean = dropSecretChunks(
      docPath,
      chunks.map((chunk) => ({ chunk, content: chunk.embedText })),
      logSecrets,
    ).map(({ chunk }) => chunk)
    // Embed before touching the database: if Ollama fails, the old chunks stay.
    const embeddings = clean.length > 0 ? await embedder.embedDocuments(clean.map((chunk) => chunk.embedText)) : []
    await store.replaceDocument(
      sourceId,
      { path: docPath, title, language, contentHash: hash, allowLlm: true, mtime: null },
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

  const kept = new Set<string>([SUMMARY_PATH])
  const keptFiles: RepoFile[] = []
  const summaryTexts = new Map<string, string>()

  for (const file of selection.included) {
    const state = states.get(file.path)
    const current = state !== undefined && state.contentHash === file.blob && !state.stale
    try {
      if (current && !isSummaryInput(file)) {
        kept.add(file.path)
        keptFiles.push(file)
        result.unchanged += 1
        continue
      }
      const bytes = await readBlob(dir, file.blob, mirror)
      // An allowlisted extension can still hold binary data.
      if (looksBinary(bytes)) {
        result.skipped.binary += 1
        continue
      }
      const text = bytes.toString('utf8')
      kept.add(file.path)
      keptFiles.push(file)
      if (isSummaryInput(file)) summaryTexts.set(file.path, text)
      if (current) {
        result.unchanged += 1
        continue
      }
      await write(file.path, path.posix.basename(file.path), file.language, file.blob, await chunkFile(repo, file, text))
      result.indexed.push(file.path)
    } catch (error) {
      kept.add(file.path)
      result.failed.push({ path: file.path, error: messageOf(error) })
    }
  }

  const readme = keptFiles
    .filter((file) => file.kind === 'readme' && summaryTexts.has(file.path))
    .sort((a, b) => Number(b.language === 'markdown') - Number(a.language === 'markdown') || (a.path < b.path ? -1 : 1))[0]
  const manifests = Object.fromEntries(
    keptFiles
      .filter((file) => file.kind === 'manifest')
      .flatMap((file) => {
        const text = summaryTexts.get(file.path)
        return text === undefined ? [] : [[file.path, text] as const]
      }),
  )
  const summary = buildRepoSummary({
    repo,
    branch: options.branch,
    files: keptFiles.map((file) => ({ path: file.path, language: file.language })),
    readme: readme === undefined ? null : (summaryTexts.get(readme.path) ?? null),
    manifests,
  })
  const summaryHash = sha256(summary.content)
  const summaryState = states.get(SUMMARY_PATH)
  if (summaryState === undefined || summaryState.contentHash !== summaryHash || summaryState.stale) {
    try {
      await write(SUMMARY_PATH, `${repo} overview`, null, summaryHash, [summary])
      result.summary = 'indexed'
    } catch (error) {
      result.summary = 'failed'
      result.failed.push({ path: SUMMARY_PATH, error: messageOf(error) })
    }
  }

  const gone = [...states.keys()].filter((docPath) => !kept.has(docPath)).sort()
  if (gone.length > 0) {
    await store.deleteDocuments(sourceId, gone)
    result.deleted = gone
  }
  return result
}

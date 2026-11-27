import { createHash } from 'node:crypto'
import type { DocumentState, IndexStore } from '../db/indexStore.js'
import type { Embedder } from '../embed/ollama.js'
import { dropSecretChunks, logSecretsDrop, type SecretsDropLogger } from '../security/secrets.js'
import { keepNoteMarkdown, type KeepNote, type KeepSkipped, type KeepTakeout } from './keepTakeout.js'
import { isKeepLocked, type LlmExclusion } from './llmExclusions.js'
import { chunkMarkdown } from './markdownChunker.js'

export interface KeepImporterOptions {
  sourceId: number
  store: IndexStore
  embedder: Embedder
  /**
   * The Gemini list (R16), read at the start of every import. A `keep` rule
   * locks every Keep note (`allow_llm = false`). Absent means empty.
   */
  exclusions?: () => Promise<readonly LlmExclusion[]>
  logSecrets?: SecretsDropLogger
}

export interface KeepImportResult {
  /** Keep notes found in the zip, after trashed, empty and blocked ones were skipped. */
  notes: number
  /** Notes (re-)embedded and written. */
  indexed: number
  /** Notes whose text matched the stored copy; Ollama was not called for them. */
  unchanged: number
  /** Stored Keep notes that are not in this export any more. */
  deleted: number
  /** Notes left as they were (or not added) because embedding or the write failed. */
  failed: number
  skipped: KeepSkipped
}

export interface KeepImporter {
  /**
   * Makes the stored Keep documents match the export: adds and updates its
   * notes and deletes every stored note it does not contain. Imports run one
   * at a time.
   */
  importNotes(takeout: KeepTakeout): Promise<KeepImportResult>
}

/**
 * Keep notes may go to Gemini, like Obsidian notes (R12, owner decision
 * 2026-11-26). Keep has no frontmatter, so no note can opt out on its own.
 */
export const KEEP_ALLOW_LLM = true

const hashOf = (title: string, markdown: string): string =>
  createHash('sha256').update(JSON.stringify([title, markdown])).digest('hex')

export function createKeepImporter(options: KeepImporterOptions): KeepImporter {
  const { sourceId, store, embedder } = options
  const logSecrets = options.logSecrets ?? logSecretsDrop
  let queue: Promise<unknown> = Promise.resolve()

  /** Returns false when the stored copy was already current (its `allow_llm` may still be corrected). */
  async function writeNote(note: KeepNote, state: DocumentState | undefined, allowLlm: boolean): Promise<boolean> {
    const markdown = keepNoteMarkdown(note)
    const contentHash = hashOf(note.title, markdown)
    if (state !== undefined && state.contentHash === contentHash && !state.stale) {
      // Bring the flag in line with the Keep lock (and notes stored before T26) without re-embedding.
      if (state.allowLlm !== allowLlm) await store.setAllowLlm(sourceId, note.path, allowLlm)
      return false
    }
    const chunked = chunkMarkdown(`${note.path}.md`, markdown, { title: note.title })
    const clean = dropSecretChunks(
      note.path,
      chunked.chunks.map((chunk) => ({ chunk, content: chunk.embedText })),
      logSecrets,
    ).map(({ chunk }) => chunk)
    // Embed before the write, so an Ollama failure leaves the stored note as it was.
    const embeddings = clean.length > 0 ? await embedder.embedDocuments(clean.map((chunk) => chunk.embedText)) : []
    await store.replaceDocument(
      sourceId,
      {
        path: note.path,
        title: note.title,
        language: 'markdown',
        contentHash,
        allowLlm,
        mtime: note.editedAt,
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
    return true
  }

  async function run(takeout: KeepTakeout): Promise<KeepImportResult> {
    const result: KeepImportResult = {
      notes: takeout.notes.length,
      indexed: 0,
      unchanged: 0,
      deleted: 0,
      failed: 0,
      skipped: { ...takeout.skipped },
    }
    const exclusions = (await options.exclusions?.()) ?? []
    const allowLlm = KEEP_ALLOW_LLM && !isKeepLocked(exclusions)
    const states = await store.getDocumentStates(sourceId, embedder.model)
    for (const note of takeout.notes) {
      const state = states.get(note.path)
      try {
        if (await writeNote(note, state, allowLlm)) result.indexed++
        else result.unchanged++
      } catch {
        // Counted, not logged with detail: the error can quote note text.
        result.failed++
      }
    }
    const inExport = new Set(takeout.notes.map((note) => note.path))
    const gone = [...states.keys()].filter((path) => !inExport.has(path))
    if (gone.length > 0) result.deleted = await store.deleteDocuments(sourceId, gone)
    return result
  }

  return {
    importNotes(takeout) {
      const next = queue.then(
        () => run(takeout),
        () => run(takeout),
      )
      queue = next.catch(() => undefined)
      return next
    },
  }
}

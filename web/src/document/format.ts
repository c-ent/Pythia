import { ApiError } from '../api/client'
import type { DocumentView } from '../api/documents'
import { SOURCE_KINDS, type SourceKind } from '../api/search'
import type { CachedDocument } from '../offline/db'

/**
 * Languages `rehype-highlight` knows (lowlight's `common` set), keyed by the
 * language names the repo filter stores (server/src/ingest/repoFilter.ts).
 * Anything else renders as a plain code block.
 */
const HIGHLIGHT_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  css: 'css',
  go: 'go',
  graphql: 'graphql',
  ini: 'ini',
  java: 'java',
  javascript: 'javascript',
  json: 'json',
  kotlin: 'kotlin',
  less: 'less',
  lua: 'lua',
  make: 'makefile',
  markdown: 'markdown',
  php: 'php',
  python: 'python',
  r: 'r',
  ruby: 'ruby',
  rust: 'rust',
  scss: 'scss',
  sql: 'sql',
  swift: 'swift',
  typescript: 'typescript',
  tsx: 'typescript',
  toml: 'ini',
  html: 'xml',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  astro: 'xml',
  yaml: 'yaml',
}

export function highlightLanguage(language: string | null): string | null {
  if (language === null) return null
  return Object.hasOwn(HIGHLIGHT_LANGUAGES, language) ? (HIGHLIGHT_LANGUAGES[language] ?? null) : null
}

/** Notes and Markdown READMEs render as Markdown; repo files render as code. */
export function isMarkdown(doc: Pick<DocumentView, 'language' | 'source'>): boolean {
  if (doc.language === 'markdown') return true
  return doc.language === null && doc.source.kind !== 'repo'
}

/**
 * The file as one fenced Markdown code block. The fence is longer than any
 * backtick run in the file, so a file that contains ``` cannot end it early.
 */
export function codeFence(content: string, language: string | null): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const body = content.endsWith('\n') ? content : `${content}\n`
  return `${fence}${highlightLanguage(language) ?? ''}\n${body}${fence}\n`
}

const isSourceKind = (kind: string): kind is SourceKind => (SOURCE_KINDS as readonly string[]).includes(kind)

/** The offline copy in the shape the server sends, or null for a kind the viewer does not show. */
export function fromCached(doc: CachedDocument): DocumentView | null {
  if (!isSourceKind(doc.sourceKind)) return null
  return {
    id: doc.id,
    source: { kind: doc.sourceKind, name: doc.sourceName },
    path: doc.path,
    title: doc.title,
    language: doc.language,
    allowLlm: doc.allowLlm,
    mtime: doc.mtime,
    updatedAt: doc.updatedAt,
    content: doc.content,
    truncated: doc.truncated,
    totalChars: doc.content.length,
  }
}

/** Thrown when the server cannot be asked and the device has no copy. */
export class NotCachedError extends Error {
  override name = 'NotCachedError'
  readonly offline: boolean

  constructor(offline: boolean) {
    super(offline ? 'offline and not cached' : 'unreachable and not cached')
    this.offline = offline
  }
}

export function documentErrorMessage(error: unknown): string {
  if (error instanceof NotCachedError) {
    return error.offline
      ? 'You’re offline, and this document isn’t saved on this device.'
      : 'Can’t reach the server, and this document isn’t saved on this device.'
  }
  if (error instanceof ApiError && error.status === 404) return 'This document isn’t in the index anymore.'
  if (error instanceof ApiError && error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
  return 'Couldn’t open this document. Try again.'
}

/** True when trying again could help (not for a document that is gone). */
export function canRetry(error: unknown): boolean {
  return !(error instanceof ApiError && error.status === 404)
}

/** A note under the header when the text is cut short, or null. */
export function truncationNote(doc: Pick<DocumentView, 'content' | 'truncated' | 'totalChars'>): string | null {
  if (!doc.truncated) return null
  if (doc.totalChars > doc.content.length) {
    const shown = doc.content.length.toLocaleString('en-US')
    const total = doc.totalChars.toLocaleString('en-US')
    return `This document is long. Showing the first ${shown} of ${total} characters.`
  }
  return 'This document is long. Showing the first part only.'
}

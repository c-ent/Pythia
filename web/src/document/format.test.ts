import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import type { CachedDocument } from '../offline/db'
import {
  canRetry,
  codeFence,
  documentErrorMessage,
  fromCached,
  highlightLanguage,
  isMarkdown,
  NotCachedError,
  truncationNote,
} from './format'

const cached = (over: Partial<CachedDocument> = {}): CachedDocument => ({
  id: 3,
  sourceKind: 'obsidian',
  sourceName: 'vault',
  path: 'Kitchen/Sourdough.md',
  title: 'Sourdough',
  language: 'markdown',
  allowLlm: true,
  mtime: null,
  updatedAt: '2026-11-26T00:00:00.000Z',
  content: 'Feed the starter.',
  truncated: false,
  ...over,
})

describe('document format', () => {
  it('renders notes and Markdown READMEs as Markdown, other repo files as code', () => {
    expect(isMarkdown({ language: 'markdown', source: { kind: 'obsidian', name: 'vault' } })).toBe(true)
    expect(isMarkdown({ language: 'markdown', source: { kind: 'repo', name: 'app' } })).toBe(true)
    expect(isMarkdown({ language: null, source: { kind: 'keep', name: 'keep' } })).toBe(true)
    expect(isMarkdown({ language: 'typescript', source: { kind: 'repo', name: 'app' } })).toBe(false)
    expect(isMarkdown({ language: null, source: { kind: 'repo', name: 'app' } })).toBe(false)
  })

  it('maps repo-filter languages to highlight.js names and drops unknown ones', () => {
    expect(highlightLanguage('typescript')).toBe('typescript')
    expect(highlightLanguage('tsx')).toBe('typescript')
    expect(highlightLanguage('make')).toBe('makefile')
    expect(highlightLanguage('vue')).toBe('xml')
    expect(highlightLanguage('zig')).toBeNull()
    expect(highlightLanguage('constructor')).toBeNull()
    expect(highlightLanguage(null)).toBeNull()
  })

  it('fences code with a fence longer than any backtick run inside it', () => {
    expect(codeFence('const a = 1', 'typescript')).toBe('```typescript\nconst a = 1\n```\n')
    expect(codeFence('x\n', null)).toBe('```\nx\n```\n')
    const fenced = codeFence('text\n```\nstill code\n', 'python')
    expect(fenced.startsWith('````python\n')).toBe(true)
    expect(fenced.endsWith('\n````\n')).toBe(true)
  })

  it('turns an offline copy into the server shape', () => {
    expect(fromCached(cached())).toEqual({
      id: 3,
      source: { kind: 'obsidian', name: 'vault' },
      path: 'Kitchen/Sourdough.md',
      title: 'Sourdough',
      language: 'markdown',
      allowLlm: true,
      mtime: null,
      updatedAt: '2026-11-26T00:00:00.000Z',
      content: 'Feed the starter.',
      truncated: false,
      totalChars: 17,
    })
    expect(fromCached(cached({ sourceKind: 'chat' }))).toBeNull()
  })

  it('explains each failure and offers Retry except for a missing document', () => {
    expect(documentErrorMessage(new NotCachedError(true))).toMatch(/offline/)
    expect(documentErrorMessage(new NotCachedError(false))).toMatch(/Can’t reach the server/)
    expect(documentErrorMessage(new ApiError(404, 'not_found', 'Document not found'))).toMatch(/isn’t in the index/)
    expect(documentErrorMessage(new ApiError(500, 'internal', 'Internal server error'))).toMatch(/Couldn’t open/)
    expect(canRetry(new ApiError(404, 'not_found', 'gone'))).toBe(false)
    expect(canRetry(new ApiError(500, 'internal', 'boom'))).toBe(true)
    expect(canRetry(new NotCachedError(true))).toBe(true)
  })

  it('notes a cut-short document', () => {
    expect(truncationNote({ content: 'abc', truncated: false, totalChars: 3 })).toBeNull()
    expect(truncationNote({ content: 'abc', truncated: true, totalChars: 12000 })).toBe(
      'This document is long. Showing the first 3 of 12,000 characters.',
    )
    expect(truncationNote({ content: 'abc', truncated: true, totalChars: 3 })).toMatch(/first part only/)
  })
})

import { describe, expect, it } from 'vitest'
import { chunkMarkdown, estimateTokens, frontmatterAllowsLlm, frontmatterDisablesLlm } from './markdownChunker.js'

const md = (...lines: string[]): string => lines.join('\n')
const paragraph = (i: number, words = 40): string => `Paragraph ${i} ${Array(words).fill('word').join(' ')}.`

describe('allow_llm detection', () => {
  it('defaults to true', () => {
    expect(chunkMarkdown('Daily.md', '# Hi\n\ntext').allowLlm).toBe(true)
  })

  it.each([
    ['llm: false'],
    ['llm: "false"'],
    ['llm: no'],
    ['LLM: false', false],
    ['tags: [a, b]\nllm: off'],
  ])('reads frontmatter %s', (yaml, expected = true) => {
    // YAML keys are case-sensitive, so `LLM` is a different property.
    expect(frontmatterDisablesLlm(yaml)).toBe(expected)
  })

  it('applies llm: false from the frontmatter block', () => {
    const note = chunkMarkdown('Ideas.md', md('---', 'llm: false', '---', '# Idea', '', 'body'))
    expect(note.allowLlm).toBe(false)
  })

  it('keeps llm: false when the rest of the YAML is malformed', () => {
    const yaml = md('title: [unclosed', 'llm: false')
    expect(frontmatterDisablesLlm(yaml)).toBe(true)
    expect(chunkMarkdown('a.md', md('---', yaml, '---', 'body')).allowLlm).toBe(false)
  })

  it('treats malformed YAML without llm as allowed', () => {
    expect(chunkMarkdown('a.md', md('---', 'title: [unclosed', '---', 'body')).allowLlm).toBe(true)
  })

  it('ignores llm: false outside the frontmatter', () => {
    expect(chunkMarkdown('a.md', md('# Notes', '', 'llm: false')).allowLlm).toBe(true)
  })

  it('no longer excludes Private/ by itself: the exclusion list is applied by the indexer', () => {
    expect(chunkMarkdown('Private/diary.md', '# Today\n\ntext').allowLlm).toBe(true)
  })

  it.each([
    ['# Hi\n\ntext', true],
    ['---\nllm: false\n---\n# Hi', false],
    ['﻿---\r\nllm: no\r\n---\r\nbody', false],
    ['# Notes\n\nllm: false', true],
  ])('frontmatterAllowsLlm agrees with chunkMarkdown (%#)', (text, allowed) => {
    expect(frontmatterAllowsLlm(text)).toBe(allowed)
    expect(chunkMarkdown('a.md', text).allowLlm).toBe(allowed)
  })
})

describe('chunkMarkdown', () => {
  it('uses the file name as title and builds heading paths', () => {
    const note = chunkMarkdown(
      'Projects/Pythia.md',
      md('# Goals', '', paragraph(1, 300), '', '## Search', '', paragraph(2, 300), '', '# Risks', '', paragraph(3, 300)),
    )
    expect(note.title).toBe('Pythia')
    expect(note.chunks.map((chunk) => chunk.headingPath)).toEqual([
      'Pythia > Goals',
      'Pythia > Goals > Search',
      'Pythia > Risks',
    ])
    expect(note.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2])
  })

  it('prefixes the embedding text with the heading path', () => {
    const [chunk] = chunkMarkdown('Note.md', md('# Section', '', 'Body text.')).chunks
    expect(chunk?.content).toBe('# Section\n\nBody text.')
    expect(chunk?.embedText).toBe('Note > Section\n\n# Section\n\nBody text.')
  })

  it('returns no chunks for an empty file or frontmatter only', () => {
    expect(chunkMarkdown('Empty.md', '').chunks).toEqual([])
    expect(chunkMarkdown('Empty.md', '\n\n  \n').chunks).toEqual([])
    expect(chunkMarkdown('Meta.md', md('---', 'tags: [x]', '---', '')).chunks).toEqual([])
  })

  it('makes one chunk for a note without headings', () => {
    const note = chunkMarkdown('Plain.md', md('Just a thought.', '', 'Another line.'))
    expect(note.chunks).toHaveLength(1)
    expect(note.chunks[0]).toMatchObject({ headingPath: 'Plain', startLine: 1, endLine: 3 })
  })

  it('strips frontmatter and keeps original line numbers', () => {
    const note = chunkMarkdown('a.md', md('---', 'tags: [a]', '---', '', '# Title', 'line'))
    expect(note.chunks[0]).toMatchObject({ startLine: 5, endLine: 6, content: '# Title\nline' })
    expect(note.chunks[0]?.content).not.toContain('tags')
  })

  it('indexes an unclosed frontmatter block as text', () => {
    const note = chunkMarkdown('a.md', md('---', 'not closed', 'text'))
    expect(note.chunks[0]?.content).toContain('not closed')
  })

  it('handles CRLF line endings and a BOM', () => {
    const note = chunkMarkdown('a.md', '\uFEFF---\r\nllm: false\r\n---\r\n# H\r\nbody\r\n')
    expect(note.allowLlm).toBe(false)
    expect(note.chunks[0]?.content).toBe('# H\nbody')
  })

  it('ignores headings inside fenced code', () => {
    const note = chunkMarkdown(
      'Code.md',
      md('# Setup', '', '```bash', '# install deps', 'pnpm install', '```', '', '~~~', '## not a heading', '~~~'),
    )
    expect(note.chunks).toHaveLength(1)
    expect(note.chunks[0]?.headingPath).toBe('Code > Setup')
    expect(note.chunks[0]?.content).toContain('# install deps')
  })

  it('does not treat #tags or closing hashes as headings', () => {
    const note = chunkMarkdown('Tags.md', md('#tag/one and #two', '', '## Closed ##', 'text'))
    expect(note.chunks.map((chunk) => chunk.headingPath)).toEqual(['Tags', 'Tags > Closed'])
  })

  it('merges short subsections into a short parent', () => {
    const note = chunkMarkdown(
      'Small.md',
      md('# Parent', 'intro', '## Child A', 'a', '### Grandchild', 'g', '## Child B', 'b'),
    )
    expect(note.chunks).toHaveLength(1)
    expect(note.chunks[0]).toMatchObject({ headingPath: 'Small > Parent', startLine: 1, endLine: 8 })
  })

  it('does not merge sibling sections', () => {
    const note = chunkMarkdown('Siblings.md', md('# A', 'a', '# B', 'b'))
    expect(note.chunks.map((chunk) => chunk.headingPath)).toEqual(['Siblings > A', 'Siblings > B'])
  })

  it('stops merging once the parent reaches the minimum', () => {
    const note = chunkMarkdown(
      'Sized.md',
      md('# Parent', paragraph(1, 25), '## Child', paragraph(2, 25), '## Other', paragraph(3, 25)),
      { minTokens: 40, maxTokens: 200 },
    )
    expect(note.chunks.map((chunk) => chunk.headingPath)).toEqual(['Sized > Parent', 'Sized > Parent > Other'])
  })

  it('folds a heading-only section into the chunk below it', () => {
    const note = chunkMarkdown('H.md', md('# Project', '## Goals', 'ship it'))
    expect(note.chunks).toHaveLength(1)
    expect(note.chunks[0]).toMatchObject({ headingPath: 'H > Project', content: '# Project\n## Goals\nship it' })
  })

  it('drops a trailing heading with no body', () => {
    const note = chunkMarkdown('T.md', md('# A', paragraph(1, 300), '# Empty', ''))
    expect(note.chunks.map((chunk) => chunk.headingPath)).toEqual(['T > A'])
  })

  it('splits a huge section at paragraph breaks, keeping every paragraph whole', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(i))
    const note = chunkMarkdown('Big.md', md('# Log', '', paragraphs.join('\n\n')))

    expect(note.chunks.length).toBeGreaterThan(1)
    for (const chunk of note.chunks) {
      expect(chunk.headingPath).toBe('Big > Log')
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(500)
    }
    const seen = note.chunks.flatMap((chunk) => chunk.content.split('\n\n')).filter((part) => part !== '# Log')
    expect(seen).toEqual(paragraphs)
    for (let i = 1; i < note.chunks.length; i++) {
      expect(note.chunks[i]!.startLine).toBeGreaterThan(note.chunks[i - 1]!.endLine)
    }
  })

  it('splits a section with one enormous line', () => {
    const line = Array(3000).fill('token').join(' ')
    const note = chunkMarkdown('Line.md', md('# One', line))
    expect(note.chunks.length).toBeGreaterThan(1)
    for (const chunk of note.chunks) expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(500)
    const words = note.chunks.flatMap((chunk) => chunk.content.replace('# One', '').split(/\s+/).filter(Boolean))
    expect(words).toHaveLength(3000)
    expect(note.chunks.at(-1)).toMatchObject({ startLine: 2, endLine: 2 })
  })

  it('splits an oversized code block by lines when it has no blank lines', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const value${i} = compute(${i})`)
    const note = chunkMarkdown('Code.md', md('# Big', '```ts', ...code, '```'))
    expect(note.chunks.length).toBeGreaterThan(1)
    for (const chunk of note.chunks) expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(500)
    expect(note.chunks.flatMap((chunk) => chunk.content.split('\n')).filter((l) => l.startsWith('const'))).toEqual(code)
  })
})

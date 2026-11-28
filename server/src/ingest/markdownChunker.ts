import { parse as parseYaml } from 'yaml'
import { noteTags } from './noteTags.js'

export const DEFAULT_MIN_TOKENS = 300
export const DEFAULT_MAX_TOKENS = 500

// Rough size for English prose under nomic-embed-text's BERT-style tokenizer.
// Good enough to size chunks; Ollama runs nomic-embed-text with a 2048-token
// context, so even a 2x underestimate of a 500-token chunk fits.
const CHARS_PER_TOKEN = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export interface MarkdownChunk {
  ordinal: number
  /** `Note > Section > Subsection`; just `Note` for text above the first heading. */
  headingPath: string
  /** 1-based lines in the original file, frontmatter included. */
  startLine: number
  endLine: number
  content: string
  /** Heading path and content, ready for the `search_document: ` prefix. */
  embedText: string
}

export interface ChunkedNote {
  title: string
  allowLlm: boolean
  /** Frontmatter and inline tags, lower case, without `#`, sorted (R16 tag rules). */
  tags: string[]
  chunks: MarkdownChunk[]
}

export interface ChunkOptions {
  /** Note title; defaults to the file name without `.md`. Keep notes carry their own. */
  title?: string
  /** Short sections below this are merged with their subsections. */
  minTokens?: number
  /** Sections above this are split, at paragraph breaks where possible. */
  maxTokens?: number
}

interface Line {
  no: number
  text: string
}

interface Section {
  path: string[]
  lines: Line[]
  headingLine: Line | undefined
}

interface Candidate {
  path: string[]
  lines: Line[]
  hasBody: boolean
  whole: boolean
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const FALSE_WORD = /^(?:false|no|off)$/i
const LLM_FALSE_LINE = /^\s*llm\s*:\s*["']?(?:false|no|off)["']?\s*(?:#.*)?$/im

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\/+/, '')
}

function titleFromPath(path: string): string {
  const fileName = normalizePath(path).split('/').at(-1) ?? ''
  return fileName.replace(/\.md$/i, '')
}

function splitFrontmatter(lines: string[]): { yaml: string | null; bodyStart: number } {
  if (lines[0]?.trim() !== '---') return { yaml: null, bodyStart: 0 }
  for (let i = 1; i < lines.length; i++) {
    const marker = lines[i]?.trim()
    if (marker === '---' || marker === '...') return { yaml: lines.slice(1, i).join('\n'), bodyStart: i + 1 }
  }
  // Unclosed block: Obsidian shows it as text, so it is indexed as text.
  return { yaml: null, bodyStart: 0 }
}

/** The note's frontmatter YAML, read as `chunkMarkdown` does, or null when it has none. */
export function noteFrontmatter(markdown: string): string | null {
  return splitFrontmatter(markdown.replace(/^\uFEFF/, '').split(/\r?\n/)).yaml
}

/** True when frontmatter sets `llm: false` (also `no` / `off`, any case). */
export function frontmatterDisablesLlm(yaml: string): boolean {
  try {
    const data: unknown = parseYaml(yaml)
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
    const value = (data as Record<string, unknown>).llm
    return value === false || (typeof value === 'string' && FALSE_WORD.test(value.trim()))
  } catch {
    // A YAML error elsewhere in the block must not re-enable LLM access for a
    // note that clearly asked to be kept out.
    return LLM_FALSE_LINE.test(yaml)
  }
}

function closesFence(open: string, match: RegExpExecArray | null): boolean {
  return match !== null && match[1][0] === open[0] && match[1].length >= open.length
}

function splitSections(lines: Line[]): Section[] {
  const sections: Section[] = []
  const stack: { level: number; text: string }[] = []
  let current: Section = { path: [], lines: [], headingLine: undefined }
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line.text)
    if (fence !== null) {
      if (closesFence(fence, fenceMatch)) fence = null
      current.lines.push(line)
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      current.lines.push(line)
      continue
    }
    const heading = HEADING.exec(line.text)
    if (heading) {
      const level = heading[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: heading[2].trim() })
      sections.push(current)
      current = { path: stack.map((entry) => entry.text), lines: [line], headingLine: line }
      continue
    }
    current.lines.push(line)
  }
  sections.push(current)
  return sections
}

function hasBody(lines: readonly Line[], headingLine: Line | undefined): boolean {
  return lines.some((line) => line !== headingLine && line.text.trim() !== '')
}

function renderLength(lines: readonly Line[]): number {
  return lines.reduce((sum, line) => sum + line.text.length + 1, 0)
}

function explodeLongLines(lines: readonly Line[], maxChars: number): Line[] {
  const out: Line[] = []
  for (const line of lines) {
    if (line.text.length <= maxChars) {
      out.push(line)
      continue
    }
    let rest = line.text
    while (rest.length > maxChars) {
      const space = rest.lastIndexOf(' ', maxChars)
      const cut = space > 0 ? space : maxChars
      out.push({ no: line.no, text: rest.slice(0, cut) })
      rest = rest.slice(cut).replace(/^ +/, '')
    }
    if (rest.length > 0) out.push({ no: line.no, text: rest })
  }
  return out
}

/** Blank lines outside fenced code: the places a long section may be cut. */
function paragraphBreaks(lines: readonly Line[]): boolean[] {
  let fence: string | null = null
  return lines.map((line) => {
    const fenceMatch = FENCE.exec(line.text)
    if (fence !== null) {
      if (closesFence(fence, fenceMatch)) fence = null
      return false
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      return false
    }
    return line.text.trim() === ''
  })
}

function splitLongSection(lines: readonly Line[], maxTokens: number): Line[][] {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  const exploded = explodeLongLines(lines, maxChars)
  const isBreak = paragraphBreaks(exploded)
  const pieces: Line[][] = []
  let current: Line[] = []
  let currentChars = 0
  let cutAfter = -1

  exploded.forEach((line, index) => {
    const added = line.text.length + 1
    if (current.length > 0 && currentChars + added > maxChars) {
      if (cutAfter > 0) {
        pieces.push(current.slice(0, cutAfter))
        current = current.slice(cutAfter)
      } else {
        pieces.push(current)
        current = []
      }
      currentChars = renderLength(current)
      cutAfter = -1
    }
    current.push(line)
    currentChars += added
    if (isBreak[index]) cutAfter = current.length
  })
  if (current.length > 0) pieces.push(current)
  return pieces
}

function isDescendant(parent: readonly string[], child: readonly string[]): boolean {
  return child.length > parent.length && parent.every((part, i) => child[i] === part)
}

function trimBlankLines(lines: readonly Line[]): Line[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].text.trim() === '') start++
  while (end > start && lines[end - 1].text.trim() === '') end--
  return lines.slice(start, end)
}

/**
 * Splits one Obsidian note into heading-scoped chunks. Pure: reads nothing
 * from disk, so the indexer decides which files reach it.
 */
export function chunkMarkdown(path: string, markdown: string, options: ChunkOptions = {}): ChunkedNote {
  const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const title = options.title ?? titleFromPath(path)

  const rawLines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/)
  const { yaml, bodyStart } = splitFrontmatter(rawLines)
  // Frontmatter only; the vault indexer applies the Gemini exclusion list (R3) on top.
  const allowLlm = !(yaml !== null && frontmatterDisablesLlm(yaml))
  const tags = noteTags(yaml, rawLines.slice(bodyStart))

  const lines: Line[] = rawLines.slice(bodyStart).map((text, i) => ({ no: bodyStart + i + 1, text }))

  const candidates: Candidate[] = []
  for (const section of splitSections(lines)) {
    if (estimateTokens(section.lines.map((line) => line.text).join('\n')) <= maxTokens) {
      candidates.push({
        path: section.path,
        lines: section.lines,
        hasBody: hasBody(section.lines, section.headingLine),
        whole: true,
      })
      continue
    }
    for (const piece of splitLongSection(section.lines, maxTokens)) {
      candidates.push({ path: section.path, lines: piece, hasBody: hasBody(piece, section.headingLine), whole: false })
    }
  }

  const merged: Candidate[] = []
  for (const candidate of candidates) {
    const previous = merged.at(-1)
    // Text above the first heading (empty path) never absorbs sections: every
    // path descends from the empty one, so it would swallow the whole note.
    if (
      previous?.whole === true &&
      previous.path.length > 0 &&
      candidate.whole &&
      isDescendant(previous.path, candidate.path) &&
      estimateTokens(previous.lines.map((line) => line.text).join('\n')) < minTokens &&
      estimateTokens([...previous.lines, ...candidate.lines].map((line) => line.text).join('\n')) <= maxTokens
    ) {
      previous.lines = [...previous.lines, ...candidate.lines]
      previous.hasBody ||= candidate.hasBody
      continue
    }
    merged.push({ ...candidate })
  }

  const chunks: MarkdownChunk[] = []
  for (const candidate of merged) {
    const body = trimBlankLines(candidate.lines)
    if (!candidate.hasBody || body.length === 0) continue
    const headingPath = [title, ...candidate.path].join(' > ')
    const content = body.map((line) => line.text).join('\n')
    chunks.push({
      ordinal: chunks.length,
      headingPath,
      startLine: body[0].no,
      endLine: body[body.length - 1].no,
      content,
      embedText: `${headingPath}\n\n${content}`,
    })
  }

  return { title, allowLlm, tags, chunks }
}

/**
 * False when the note's frontmatter sets `llm: false`; the same reading
 * `chunkMarkdown` uses, without chunking. The exclusion list is applied by
 * the caller.
 */
export function frontmatterAllowsLlm(markdown: string): boolean {
  return noteLlmMeta(markdown).allowLlm
}

/** `allowLlm` from frontmatter and the note's tags, read as `chunkMarkdown` does, without chunking. */
export function noteLlmMeta(markdown: string): { allowLlm: boolean; tags: string[] } {
  const rawLines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/)
  const { yaml, bodyStart } = splitFrontmatter(rawLines)
  return {
    allowLlm: !(yaml !== null && frontmatterDisablesLlm(yaml)),
    tags: noteTags(yaml, rawLines.slice(bodyStart)),
  }
}

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as TreeSitter from '@vscode/tree-sitter-wasm'

/**
 * Splits a source file into chunks at function and class boundaries (R9),
 * using tree-sitter grammars compiled to WebAssembly (no native build, no
 * install scripts). Languages without a grammar, and files that fail to
 * parse, fall back to 80-line windows. Pure apart from loading the grammar
 * files once: no I/O on the repo, no network, no LLM.
 */

type TreeSitterModule = typeof TreeSitter
type SyntaxNode = TreeSitter.Node

/** Fallback window and the split size for symbols that are too big to keep whole. */
export const WINDOW_LINES = 80
/** A symbol up to this many lines (and MAX_CHUNK_CHARS) stays one chunk. */
export const MAX_SYMBOL_LINES = 120
/**
 * Neighbours this short (one-line aliases, constants, imports) are merged with
 * each other, and a run still this short (imports, a class header) joins the
 * piece after it.
 */
export const TINY_LINES = 2
/** A merged run of tiny pieces stays within this many lines. */
export const MERGE_LINES = 30

const lineCount = (unit: { start: number; end: number }): number => unit.end - unit.start + 1
/** About 2000 tokens: what nomic-embed-text reads in one go. */
export const MAX_CHUNK_CHARS = 8000

/** Repo-filter language name (see `repoFilter.ts`) to the grammar file it parses with. */
const GRAMMARS: Readonly<Record<string, string>> = {
  typescript: 'typescript',
  tsx: 'tsx',
  javascript: 'javascript',
  python: 'python',
  php: 'php',
  go: 'go',
  rust: 'rust',
  java: 'java',
  ruby: 'ruby',
  csharp: 'c-sharp',
  cpp: 'cpp',
  // C parses well enough with the C++ grammar for symbol boundaries.
  c: 'cpp',
  bash: 'bash',
  powershell: 'powershell',
}

export const PARSED_LANGUAGES: readonly string[] = Object.keys(GRAMMARS)

export interface CodeChunk {
  ordinal: number
  /** `path > Class > method`; just the path for file-level code and line windows. */
  headingPath: string
  /** 1-based, inclusive. */
  startLine: number
  endLine: number
  content: string
  /** Repo name, heading path and content, ready for the `search_document: ` prefix. */
  embedText: string
}

export interface ChunkedCode {
  chunks: CodeChunk[]
  /** How the file was split: by syntax tree, or by line windows. */
  method: 'tree-sitter' | 'lines'
}

export interface CodeFile {
  repo: string
  /** Repo-relative, `/` separators. */
  path: string
  /** From `classifyRepoPath`; null or unknown means line windows. */
  language: string | null
  content: string
}

const require = createRequire(import.meta.url)
let runtime: Promise<{ ts: TreeSitterModule; dir: string }> | null = null
const parsers = new Map<string, Promise<TreeSitter.Parser>>()

function loadRuntime(): Promise<{ ts: TreeSitterModule; dir: string }> {
  runtime ??= (async () => {
    const ts = require('@vscode/tree-sitter-wasm') as TreeSitterModule
    const dir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'))
    await ts.Parser.init({ locateFile: (file: string) => path.join(dir, file) })
    return { ts, dir }
  })().catch((error: unknown) => {
    runtime = null
    throw error
  })
  return runtime
}

function parserFor(grammar: string): Promise<TreeSitter.Parser> {
  let parser = parsers.get(grammar)
  if (parser === undefined) {
    parser = (async () => {
      const { ts, dir } = await loadRuntime()
      const language = await ts.Language.load(await readFile(path.join(dir, `tree-sitter-${grammar}.wasm`)))
      const created = new ts.Parser()
      created.setLanguage(language)
      return created
    })().catch((error: unknown) => {
      parsers.delete(grammar)
      throw error
    })
    parsers.set(grammar, parser)
  }
  return parser
}

/** Node types that start a symbol chunk, across the bundled grammars. */
const SYMBOL_TYPES = new Set([
  // TypeScript / JavaScript
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'internal_module',
  'method_definition',
  // Python, PHP, C/C++, Bash
  'function_definition',
  'class_definition',
  'namespace_definition',
  // Go, Java, C#, PHP
  'method_declaration',
  'constructor_declaration',
  'record_declaration',
  'struct_declaration',
  'namespace_declaration',
  'trait_declaration',
  // Rust
  'function_item',
  'struct_item',
  'enum_item',
  'trait_item',
  'mod_item',
  'union_item',
  'macro_definition',
  // Ruby (and TypeScript `module`)
  'class',
  'module',
  'method',
  'singleton_method',
])

const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
  'class',
])

interface SymbolInfo {
  name: string
  /** Body whose members become their own chunks when the symbol is too big. */
  body: SyntaxNode | null
}

const cleanName = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 80)

function declaratorName(node: SyntaxNode): string | null {
  // C/C++: function_definition > declarator: function_declarator > declarator: identifier
  let current: SyntaxNode | null = node.childForFieldName('declarator')
  let last: SyntaxNode | null = null
  while (current !== null && last !== current) {
    last = current
    current = current.childForFieldName('declarator') ?? current
  }
  return last === null ? null : cleanName(last.text)
}

function symbolInfo(node: SyntaxNode): SymbolInfo | null {
  switch (node.type) {
    case 'export_statement': {
      const declaration =
        node.childForFieldName('declaration') ?? node.namedChildren.find((child) => child !== null && symbolInfo(child) !== null)
      return declaration ? symbolInfo(declaration) : null
    }
    case 'decorated_definition': {
      const definition = node.childForFieldName('definition')
      return definition === null ? null : symbolInfo(definition)
    }
    case 'template_declaration': {
      const inner = node.lastNamedChild
      return inner === null ? null : symbolInfo(inner)
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const declarator of node.namedChildren) {
        if (declarator?.type !== 'variable_declarator') continue
        const value = declarator.childForFieldName('value')
        const name = declarator.childForFieldName('name')
        if (value !== null && name !== null && FUNCTION_VALUES.has(value.type)) {
          return { name: cleanName(name.text), body: value.type === 'class' ? value.childForFieldName('body') : null }
        }
      }
      return null
    }
    case 'type_declaration': {
      // Go: type_declaration > type_spec name
      const spec = node.namedChildren.find((child) => child?.type === 'type_spec')
      const name = spec?.childForFieldName('name')
      return name ? { name: cleanName(name.text), body: null } : null
    }
    case 'namespace_definition': {
      // PHP `namespace App\Models;` has no body: it is a file header, not a symbol.
      const body = node.childForFieldName('body')
      if (body === null) return null
      return { name: cleanName(node.childForFieldName('name')?.text ?? 'namespace'), body }
    }
    case 'impl_item': {
      const type = node.childForFieldName('type')
      const trait = node.childForFieldName('trait')
      const name = `impl ${trait === null ? '' : `${trait.text} for `}${type?.text ?? ''}`
      return { name: cleanName(name), body: node.childForFieldName('body') }
    }
    default: {
      if (!SYMBOL_TYPES.has(node.type)) return null
      const name = node.childForFieldName('name')?.text ?? declaratorName(node) ?? node.type
      return { name: cleanName(name), body: node.childForFieldName('body') }
    }
  }
}

/** Last row the node covers; a node ending at column 0 ends on the row before. */
function endRow(node: SyntaxNode): number {
  const end = node.endPosition
  return end.column === 0 && end.row > node.startPosition.row ? end.row - 1 : end.row
}

interface Unit {
  /** 0-based rows, inclusive. */
  start: number
  end: number
  /** Symbol names below the file, outermost first. */
  path: string[]
  /** `[n, total]` when a too-big symbol was split into windows. */
  part?: [number, number]
}

const ONLY_PUNCTUATION = /^[\s{}()[\];,]*$/

function splitter(lines: readonly string[]) {
  const lineChars = (row: number): number => (lines[row]?.length ?? 0) + 1
  const span = (start: number, end: number): number => {
    let chars = 0
    for (let row = start; row <= end; row += 1) chars += lineChars(row)
    return chars
  }

  /** Row ranges of at most WINDOW_LINES lines and about MAX_CHUNK_CHARS characters. */
  function windows(start: number, end: number): Array<[number, number]> {
    const ranges: Array<[number, number]> = []
    let from = start
    let chars = 0
    for (let row = start; row <= end; row += 1) {
      const size = lineChars(row)
      if (row > from && (row - from >= WINDOW_LINES || chars + size > MAX_CHUNK_CHARS)) {
        ranges.push([from, row - 1])
        from = row
        chars = 0
      }
      chars += size
    }
    if (from <= end) ranges.push([from, end])
    return ranges
  }

  /** File-level or between-member code: trimmed, punctuation-only runs dropped. */
  function plain(start: number, end: number, prefix: string[]): Unit[] {
    while (start <= end && (lines[start] ?? '').trim() === '') start += 1
    while (end >= start && (lines[end] ?? '').trim() === '') end -= 1
    if (start > end) return []
    if (lines.slice(start, end + 1).every((line) => ONLY_PUNCTUATION.test(line))) return []
    return windows(start, end).map(([from, to]) => ({ start: from, end: to, path: prefix }))
  }

  function segment(nodes: readonly (SyntaxNode | null)[], from: number, to: number, prefix: string[], depth: number): Unit[] {
    const symbols: Array<SymbolInfo & { start: number; end: number }> = []
    let commentStart: number | null = null
    let commentEnd = -2
    let lastEnd = from - 1
    for (const node of nodes) {
      if (node === null) continue
      const start = node.startPosition.row
      const end = endRow(node)
      if (node.type.includes('comment')) {
        if (commentStart === null || start > commentEnd + 1) commentStart = start
        commentEnd = end
        continue
      }
      const info = symbolInfo(node)
      if (info !== null && start >= from && end <= to) {
        // Doc comments directly above a symbol belong to it.
        const attached = commentStart !== null && start <= commentEnd + 1 ? commentStart : start
        symbols.push({ ...info, start: Math.max(attached, lastEnd + 1), end })
        lastEnd = end
      }
      commentStart = null
    }

    const units: Unit[] = []
    let cursor = from
    for (const symbol of symbols) {
      if (symbol.start > cursor) units.push(...plain(cursor, symbol.start - 1, prefix))
      units.push(...symbolUnits(symbol, prefix, depth))
      cursor = symbol.end + 1
    }
    if (cursor <= to) units.push(...plain(cursor, to, prefix))
    return units
  }

  function symbolUnits(symbol: SymbolInfo & { start: number; end: number }, prefix: string[], depth: number): Unit[] {
    const symbolPath = [...prefix, symbol.name]
    const lineCount = symbol.end - symbol.start + 1
    if (lineCount <= MAX_SYMBOL_LINES && span(symbol.start, symbol.end) <= MAX_CHUNK_CHARS) {
      return [{ start: symbol.start, end: symbol.end, path: symbolPath }]
    }
    const members = symbol.body?.namedChildren ?? []
    if (depth < 4 && members.some((member) => member !== null && symbolInfo(member) !== null)) {
      return segment(members, symbol.start, symbol.end, symbolPath, depth + 1)
    }
    const ranges = windows(symbol.start, symbol.end)
    return ranges.map(([start, end], i) => ({ start, end, path: symbolPath, part: [i + 1, ranges.length] }))
  }

  return { windows, segment, span }
}

function commonPrefix(paths: readonly string[][]): string[] {
  const [first = [], ...rest] = paths
  let length = first.length
  for (const other of rest) {
    let i = 0
    while (i < length && i < other.length && other[i] === first[i]) i += 1
    length = i
  }
  return first.slice(0, length)
}

/** Merges runs of small neighbours (type aliases, short helpers, imports) into one chunk. */
function mergeSmall(units: Unit[], span: (start: number, end: number) => number): Array<Unit & { label: string[] }> {
  const groups: Unit[][] = []
  for (const unit of units) {
    const group = groups.at(-1)
    const head = group?.[0]
    const tail = group?.at(-1)
    if (
      group !== undefined &&
      head !== undefined &&
      tail !== undefined &&
      head.part === undefined &&
      unit.part === undefined &&
      // Two tiny neighbours merge, and a run that is still tiny (imports) joins the next piece.
      ((lineCount(unit) <= TINY_LINES && lineCount(tail) <= TINY_LINES && unit.end - head.start + 1 <= MERGE_LINES) ||
        (tail.end - head.start + 1 <= TINY_LINES && unit.end - head.start + 1 <= MAX_SYMBOL_LINES + TINY_LINES)) &&
      span(head.start, unit.end) <= MAX_CHUNK_CHARS
    ) {
      group.push(unit)
    } else {
      groups.push([unit])
    }
  }
  return groups.map((group) => {
    const first = group[0] as Unit
    const last = group.at(-1) as Unit
    if (group.length === 1) return { ...first, label: first.path }
    const shared = commonPrefix(group.map((unit) => unit.path))
    const names = [...new Set(group.flatMap((unit) => unit.path.slice(shared.length, shared.length + 1)))]
    const label = names.length === 0 ? shared : [...shared, names.length > 4 ? `${names.slice(0, 4).join(', ')}, …` : names.join(', ')]
    return { start: first.start, end: last.end, path: shared, label }
  })
}

function toChunks(file: CodeFile, lines: readonly string[], units: Array<Unit & { label: string[] }>): CodeChunk[] {
  return units.map((unit, ordinal) => {
    const label = [file.path, ...unit.label].join(' > ')
    const headingPath = unit.part === undefined ? label : `${label} (part ${unit.part[0]} of ${unit.part[1]})`
    const content = lines
      .slice(unit.start, unit.end + 1)
      .join('\n')
      .slice(0, MAX_CHUNK_CHARS)
    return {
      ordinal,
      headingPath,
      startLine: unit.start + 1,
      endLine: unit.end + 1,
      content,
      embedText: `${file.repo} > ${headingPath}\n\n${content}`,
    }
  })
}

/** Chunks one source file. Never throws on bad input: an unparsable file gets line windows. */
export async function chunkCode(file: CodeFile): Promise<ChunkedCode> {
  const text = file.content.charCodeAt(0) === 0xfeff ? file.content.slice(1) : file.content
  if (text.trim() === '') return { chunks: [], method: 'lines' }
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  const { windows, segment, span } = splitter(lines)
  // Trailing blank lines (the final newline) belong to no chunk.
  let lastRow = lines.length - 1
  while (lastRow > 0 && (lines[lastRow] ?? '').trim() === '') lastRow -= 1

  const grammar = file.language === null ? undefined : GRAMMARS[file.language]
  if (grammar !== undefined) {
    let tree: TreeSitter.Tree | null = null
    try {
      const parser = await parserFor(grammar)
      tree = parser.parse(text)
      if (tree !== null) {
        const units = segment(tree.rootNode.namedChildren, 0, lastRow, [], 0)
        if (units.length > 0) return { chunks: toChunks(file, lines, mergeSmall(units, span)), method: 'tree-sitter' }
      }
    } catch {
      // Fall through to line windows: a grammar that fails to load or parse
      // must not keep the file out of the index.
    } finally {
      tree?.delete()
    }
  }

  const units = windows(0, lastRow)
    .map(([start, end]) => ({ start, end, path: [] as string[], label: [] as string[] }))
    .filter((unit) => lines.slice(unit.start, unit.end + 1).some((line) => line.trim() !== ''))
  return { chunks: toChunks(file, lines, units), method: 'lines' }
}

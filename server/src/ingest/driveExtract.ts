import ExcelJS, { type CellValue, type Worksheet } from 'exceljs'
import { strFromU8, unzipSync } from 'fflate'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { chunkMarkdown, DEFAULT_MAX_TOKENS, estimateTokens, type ChunkOptions } from './markdownChunker.js'

/**
 * Text extraction for Google Drive files (R19). Pure apart from the libraries
 * it calls: it gets a file's bytes and never reads or writes the mirror, so
 * the Drive indexer decides which files reach it. No size cap: every
 * document is extracted in full.
 */

/** Why a file in the mirror was not indexed; counted on Sources and sync, never logged with content. */
export type DriveSkipReason =
  /** Images, audio, video, archives, executables, Forms, Drawings, Sites and anything else that is not a document. */
  | 'not_document'
  /** A document that holds no text. */
  | 'empty'
  /** Password-protected or encrypted. */
  | 'encrypted'
  /** Damaged, or not what its extension says. */
  | 'unreadable'
  /** An old Office or OpenDocument file LibreOffice could not convert (T64). */
  | 'conversion_failed'

export interface DriveChunk {
  ordinal: number
  /** `File > Heading > Subheading`; just `File` for text above the first heading. */
  headingPath: string
  /** 1-based lines for `.md` and `.txt`; null for formats without lines the owner would recognise. */
  startLine: number | null
  endLine: number | null
  content: string
  /** Heading path and content, ready for the `search_document: ` prefix. */
  embedText: string
}

export interface DriveDocument {
  /** File name without its extension. */
  title: string
  /** False only when a Markdown file's frontmatter sets `llm: false` (R3); the Gemini rules apply on top. */
  allowLlm: boolean
  chunks: DriveChunk[]
}

export type DriveExtraction =
  | { kind: 'document'; document: DriveDocument }
  | { kind: 'skipped'; reason: DriveSkipReason }

export type DriveExtractOptions = Pick<ChunkOptions, 'minTokens' | 'maxTokens'>

const skipped = (reason: DriveSkipReason): DriveExtraction => ({ kind: 'skipped', reason })

const fileName = (path: string): string => path.replace(/\\/g, '/').split('/').at(-1) ?? ''

/** Lower-case extension with its dot (`.docx`), or `''` when the name has none. */
export function driveExtension(path: string): string {
  const name = fileName(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** The file name without its extension, used as the document title. */
export function driveTitle(path: string): string {
  const name = fileName(path)
  const ext = driveExtension(name)
  return ext === '' ? name : name.slice(0, -ext.length)
}

// Compound File Binary header: an Office file that is a CFB container where a
// zip is expected is an encrypted (password-protected) package.
const isCompoundFile = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0

const isZip = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b

function toDocument(path: string, markdown: string, options: DriveExtractOptions, withLines: boolean): DriveExtraction {
  const note = chunkMarkdown(path, markdown, { ...options, title: driveTitle(path) })
  if (note.chunks.length === 0) return skipped('empty')
  return {
    kind: 'document',
    document: {
      title: note.title,
      allowLlm: note.allowLlm,
      chunks: note.chunks.map((chunk) => ({
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        startLine: withLines ? chunk.startLine : null,
        endLine: withLines ? chunk.endLine : null,
        content: chunk.content,
        embedText: chunk.embedText,
      })),
    },
  }
}

const decodeText = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes)

// Google Docs exports its Title style under that name; Word headings are
// mapped by mammoth's default style map.
const DOCX_STYLE_MAP = ["p[style-name='Title'] => h1:fresh"]
// Images are dropped; this converter keeps mammoth from reading their bytes.
const NO_IMAGES = mammoth.images.imgElement(() => Promise.resolve({ src: '' }))

async function extractDocx(path: string, bytes: Uint8Array, options: DriveExtractOptions): Promise<DriveExtraction> {
  if (isCompoundFile(bytes)) return skipped('encrypted')
  if (!isZip(bytes)) return skipped('unreadable')
  let html: string
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      { styleMap: DOCX_STYLE_MAP, convertImage: NO_IMAGES, externalFileAccess: false },
    )
    html = result.value
  } catch {
    return skipped('unreadable')
  }
  return toDocument(path, docxHtmlToMarkdown(html), options, false)
}

// PDF.js prints warnings for damaged files; 0 keeps them (and any text they
// quote) out of the logs.
const PDF_ERRORS_ONLY = 0

/**
 * One `Page N` section per page with text, so a citation points at a page;
 * long pages are split into ~300-500 token chunks by the R3 chunker. A PDF
 * with no text on any page (a scan) is `empty`, a password-protected one
 * `encrypted`.
 */
async function extractPdf(path: string, bytes: Uint8Array, options: DriveExtractOptions): Promise<DriveExtraction> {
  let pages: string[]
  try {
    // PDF.js takes ownership of the buffer it is given, so it gets a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), {
      verbosity: PDF_ERRORS_ONLY,
      useSystemFonts: false,
    })
    try {
      pages = (await extractText(pdf, { mergePages: false })).text
    } finally {
      await pdf.loadingTask.destroy()
    }
  } catch (error) {
    return skipped(error instanceof Error && error.name === 'PasswordException' ? 'encrypted' : 'unreadable')
  }
  const sections: string[] = []
  pages.forEach((page, index) => {
    const lines = page.split(/\r?\n/).map(collapse).filter((line) => line !== '').map(escapeLine)
    if (lines.length > 0) sections.push(`# Page ${index + 1}\n\n${lines.join('\n')}`)
  })
  if (sections.length === 0) return skipped('empty')
  return toDocument(path, sections.join('\n\n'), options, false)
}

// --- Spreadsheets: .xlsx (Google Sheets export and Excel) and .csv --------

const dateText = (date: Date): string => {
  if (Number.isNaN(date.getTime())) return ''
  const iso = date.toISOString()
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ')
}

/** A cell as text; formulas give their cached value, never the formula. */
function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return dateText(value)
  if (typeof value !== 'object') return String(value)
  if ('error' in value) return value.error
  if ('richText' in value) return value.richText.map((run) => run.text).join('')
  if ('hyperlink' in value) {
    const text: unknown = value.text
    return typeof text === 'string' ? text : cellText(text as CellValue)
  }
  if ('formula' in value || 'sharedFormula' in value) return cellText(value.result)
  return ''
}

const cleanCell = (text: string): string => collapse(text.replace(/[\r\n]+/g, ' ')).replace(/\|/g, '\\|')

const trimTrailingEmpty = (cells: string[]): string[] => {
  let end = cells.length
  while (end > 0 && cells[end - 1] === '') end--
  return cells.slice(0, end)
}

/**
 * Appends one sheet's chunks: a pipe table whose first non-empty row is the
 * header, split into row windows of at most `maxTokens` with the header
 * repeated at the top of every window. An empty sheet adds nothing.
 */
function appendSheetChunks(headingPath: string, rows: string[][], maxTokens: number, chunks: DriveChunk[]): void {
  const kept = rows.map(trimTrailingEmpty).filter((cells) => cells.length > 0)
  if (kept.length === 0) return
  const width = Math.max(...kept.map((cells) => cells.length))
  const line = (cells: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const header = `${line(kept[0]!)}\n|${' --- |'.repeat(width)}`
  const push = (window: readonly string[]): void => {
    const content = [header, ...window].join('\n')
    chunks.push({
      ordinal: chunks.length,
      headingPath,
      startLine: null,
      endLine: null,
      content,
      embedText: `${headingPath}\n\n${content}`,
    })
  }
  let window: string[] = []
  for (const row of kept.slice(1).map(line)) {
    if (window.length > 0 && estimateTokens([header, ...window, row].join('\n')) > maxTokens) {
      push(window)
      window = []
    }
    window.push(row)
  }
  push(window)
}

function worksheetRows(sheet: Worksheet): string[][] {
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values
    // Row values are 1-based and sparse; holes read as empty cells.
    const cells: (CellValue | undefined)[] = Array.isArray(values) ? Array.from(values).slice(1) : []
    rows.push(cells.map((value) => cleanCell(cellText(value))))
  })
  return rows
}

const sheetDocument = (path: string, chunks: DriveChunk[]): DriveExtraction =>
  chunks.length === 0
    ? skipped('empty')
    : { kind: 'document', document: { title: driveTitle(path), allowLlm: true, chunks } }

/** One `File > Sheet` section per sheet with cells. */
async function extractXlsx(path: string, bytes: Uint8Array, options: DriveExtractOptions): Promise<DriveExtraction> {
  if (isCompoundFile(bytes)) return skipped('encrypted')
  if (!isZip(bytes)) return skipped('unreadable')
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0])
  } catch {
    return skipped('unreadable')
  }
  // Excel and Sheets always write at least one sheet; a zip without any is
  // some other Office file under an .xlsx name.
  if (workbook.worksheets.length === 0) return skipped('unreadable')
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
  const title = driveTitle(path)
  const chunks: DriveChunk[] = []
  for (const sheet of workbook.worksheets) {
    appendSheetChunks(`${title} > ${sheet.name}`, worksheetRows(sheet), maxTokens, chunks)
  }
  return sheetDocument(path, chunks)
}

/** RFC 4180 CSV: quoted fields may hold commas, line breaks and `""` quotes. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      if (char !== '"') field += char
      else if (source[i + 1] === '"') {
        field += '"'
        i++
      } else quoted = false
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** A `.csv` is one sheet: one section named after the file. */
function extractCsv(path: string, bytes: Uint8Array, options: DriveExtractOptions): Promise<DriveExtraction> {
  const rows = parseCsv(decodeText(bytes)).map((cells) => cells.map(cleanCell))
  const chunks: DriveChunk[] = []
  appendSheetChunks(driveTitle(path), rows, options.maxTokens ?? DEFAULT_MAX_TOKENS, chunks)
  return Promise.resolve(sheetDocument(path, chunks))
}

// --- Slides: .pptx (Google Slides export and PowerPoint) -----------------

// The DrawingML parts are read with a few patterns rather than an XML
// library: only shapes, paragraphs, text runs and line breaks matter.
const SHAPE = /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g
const PARAGRAPH = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g
const RUN_OR_BREAK = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*>/g
const TITLE_PLACEHOLDERS = new Set(['title', 'ctrTitle'])
// Date, footer, slide number, header and the notes page's slide picture:
// the same on every slide, or not the owner's words.
const NOISE_PLACEHOLDERS = new Set(['dt', 'ftr', 'sldNum', 'hdr', 'sldImg'])

const xmlAttr = (attrs: string, name: string): string =>
  decodeEntities(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1] ?? '')

/** A shape's placeholder type; a placeholder without one is a body. */
function placeholderType(shape: string): string | null {
  const placeholder = /<p:ph\b([^>]*)>/.exec(shape)
  if (placeholder === null) return null
  const type = xmlAttr(placeholder[1]!, 'type')
  return type === '' ? 'body' : type
}

function paragraphLines(xml: string): string[] {
  const lines: string[] = []
  for (const [, inner] of xml.matchAll(PARAGRAPH)) {
    let text = ''
    for (const [, run] of inner!.matchAll(RUN_OR_BREAK)) text += run === undefined ? '\n' : decodeEntities(run)
    lines.push(...text.split('\n').map(collapse).filter((line) => line !== ''))
  }
  return lines
}

function slideText(xml: string): { title: string; body: string[] } {
  const titles: string[] = []
  const rest = xml.replace(SHAPE, (shape) => {
    const type = placeholderType(shape)
    if (type === null) return shape
    if (TITLE_PLACEHOLDERS.has(type)) titles.push(...paragraphLines(shape))
    return TITLE_PLACEHOLDERS.has(type) || NOISE_PLACEHOLDERS.has(type) ? '' : shape
  })
  return { title: titles.join(' '), body: paragraphLines(rest) }
}

interface Relationship {
  id: string
  type: string
  target: string
}

function relationships(xml: string | undefined): Relationship[] {
  if (xml === undefined) return []
  return [...xml.matchAll(/<Relationship\b([^>]*)>/g)].map(([, attrs]) => ({
    id: xmlAttr(attrs!, 'Id'),
    type: xmlAttr(attrs!, 'Type'),
    target: xmlAttr(attrs!, 'Target'),
  }))
}

/** `ppt/slides/slide1.xml` gives `ppt/slides/_rels/slide1.xml.rels`. */
const relsPart = (part: string): string => {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

/** Resolves a relationship target against the part that holds it. */
function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromPart.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

const slideNumber = (part: string): number => Number(/(\d+)\.xml$/.exec(part)?.[1] ?? 0)

/** Slides in presentation order; by file number when the slide list is missing. */
function slideParts(files: Record<string, string>): string[] {
  const presentation = 'ppt/presentation.xml'
  const byId = new Map(relationships(files[relsPart(presentation)]).map((rel) => [rel.id, rel]))
  const ordered = [...(files[presentation] ?? '').matchAll(/<p:sldId\b([^>]*)>/g)]
    .map(([, attrs]) => byId.get(xmlAttr(attrs!, 'r:id')))
    .filter((rel): rel is Relationship => rel !== undefined && rel.type.endsWith('/slide'))
    .map((rel) => resolvePart(presentation, rel.target))
  if (ordered.length > 0) return ordered
  return Object.keys(files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
}

/**
 * One section per slide, in presentation order: its title (or `Slide N`),
 * its text and its speaker notes. A slide with only a title keeps the title
 * as its text so it can still be found.
 */
function extractPptx(path: string, bytes: Uint8Array, options: DriveExtractOptions): DriveExtraction {
  if (isCompoundFile(bytes)) return skipped('encrypted')
  if (!isZip(bytes)) return skipped('unreadable')
  const files: Record<string, string> = {}
  try {
    const entries = unzipSync(bytes, {
      filter: (file) => file.name.startsWith('ppt/') && /\.(?:xml|rels)$/.test(file.name),
    })
    for (const [name, data] of Object.entries(entries)) files[name] = strFromU8(data)
  } catch {
    return skipped('unreadable')
  }
  // A zip without a presentation part is some other Office file under a .pptx name.
  if (files['ppt/presentation.xml'] === undefined) return skipped('unreadable')
  const sections: string[] = []
  slideParts(files).forEach((part, index) => {
    const xml = files[part]
    if (xml === undefined) return
    const { title, body } = slideText(xml)
    const notesRel = relationships(files[relsPart(part)]).find((rel) => rel.type.endsWith('/notesSlide'))
    const notesXml = notesRel === undefined ? undefined : files[resolvePart(part, notesRel.target)]
    const notes = notesXml === undefined ? [] : slideText(notesXml).body
    const lines = body.length > 0 || notes.length > 0 || title === '' ? [...body] : [title]
    if (notes.length > 0) lines.push('', 'Speaker notes:', ...notes)
    if (lines.length === 0) return
    sections.push(`# ${title === '' ? `Slide ${index + 1}` : title}\n\n${lines.map(escapeLine).join('\n')}`)
  })
  if (sections.length === 0) return skipped('empty')
  return toDocument(path, sections.join('\n\n'), options, false)
}

type Extractor = (path: string, bytes: Uint8Array, options: DriveExtractOptions) => Promise<DriveExtraction>

const EXTRACTORS: Record<string, Extractor> = {
  '.docx': extractDocx,
  '.pdf': extractPdf,
  '.xlsx': extractXlsx,
  '.csv': extractCsv,
  '.pptx': (path, bytes, options) => Promise.resolve(extractPptx(path, bytes, options)),
  '.md': (path, bytes, options) => Promise.resolve(toDocument(path, decodeText(bytes), options, true)),
  '.txt': (path, bytes, options) => Promise.resolve(toDocument(path, decodeText(bytes), options, true)),
}

/** Extensions the Drive indexer turns into documents. */
export const DRIVE_DOCUMENT_EXTENSIONS: readonly string[] = Object.keys(EXTRACTORS)

/** Extracts one mirrored Drive file; anything that is not a readable document comes back as skipped with a reason. */
export async function extractDriveFile(
  path: string,
  bytes: Uint8Array,
  options: DriveExtractOptions = {},
): Promise<DriveExtraction> {
  const extractor = EXTRACTORS[driveExtension(path)]
  if (extractor === undefined) return skipped('not_document')
  return extractor(path, bytes, options)
}

// --- mammoth HTML to Markdown for the R3 chunker -------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[name.toLowerCase()] ?? match
  })
}

const collapse = (text: string): string => text.replace(/[ \t\u00a0\r\f\v]+/g, ' ').trim()

// Document text that the chunker would read as Markdown structure (a heading,
// a code fence, a frontmatter fence) is escaped so only real Word headings
// become sections.
const STRUCTURAL_LINE = /^(?:#{1,6}(?:[ \t]|$)|`{3}|~{3}|-{3,}\s*$|\.{3}\s*$)/

const escapeLine = (line: string): string => (STRUCTURAL_LINE.test(line) ? `\\${line}` : line)

/**
 * Turns mammoth's HTML (headings, paragraphs, lists, tables, links, inline
 * formatting) into plain Markdown: `#` headings for Word headings, list items
 * as `-` / `1.` lines, tables as pipe rows. Inline formatting and images are
 * dropped; only text matters for search.
 */
export function docxHtmlToMarkdown(html: string): string {
  const out: string[] = []
  let text = ''
  let headingLevel = 0
  const lists: { ordered: boolean; count: number }[] = []
  let tableDepth = 0
  let rows: string[][] = []
  let row: string[] = []

  const blank = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  }

  const flushParagraph = (): void => {
    const lines = text.split('\n').map(collapse).filter((line) => line !== '').map(escapeLine)
    text = ''
    if (lines.length === 0) return
    blank()
    out.push(...lines)
    blank()
  }

  const flushItem = (): void => {
    const item = collapse(text.replace(/\n/g, ' '))
    text = ''
    const list = lists[lists.length - 1]
    if (item === '' || list === undefined) return
    const marker = list.ordered ? `${list.count}.` : '-'
    out.push(`${'  '.repeat(lists.length - 1)}${marker} ${item}`)
  }

  const flushTable = (): void => {
    const kept = rows.filter((cells) => cells.some((cell) => cell !== ''))
    rows = []
    if (kept.length === 0) return
    const width = Math.max(...kept.map((cells) => cells.length))
    const line = (cells: string[]): string =>
      `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
    blank()
    kept.forEach((cells, index) => {
      out.push(line(cells))
      if (index === 0) out.push(`|${' --- |'.repeat(width)}`)
    })
    blank()
  }

  const TOKEN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>|([^<]+)/g
  for (const match of html.matchAll(TOKEN)) {
    const [, closing, rawName, , textNode] = match
    if (textNode !== undefined) {
      text += decodeEntities(textNode)
      continue
    }
    const name = rawName!.toLowerCase()
    const open = closing !== '/'
    const heading = /^h([1-6])$/.exec(name)

    if (tableDepth > 0 && name !== 'table') {
      // Inside a table only rows and cells give structure; nested tables and
      // paragraphs in a cell run together as cell text.
      if (tableDepth === 1 && name === 'tr') {
        if (open) row = []
        else rows.push(row)
      } else if (tableDepth === 1 && (name === 'td' || name === 'th')) {
        if (open) text = ''
        else {
          row.push(collapse(text.replace(/\n/g, ' ')))
          text = ''
        }
      } else if (name === 'br' || name === 'p' || name === 'li' || heading !== null) {
        text += ' '
      }
      continue
    }

    if (heading !== null) {
      if (open) {
        if (lists.length > 0) flushItem()
        else flushParagraph()
        headingLevel = Number(heading[1])
      } else {
        const title = collapse(text.replace(/\n/g, ' '))
        text = ''
        if (title !== '' && headingLevel > 0) {
          blank()
          out.push(`${'#'.repeat(headingLevel)} ${title}`)
          blank()
        }
        headingLevel = 0
      }
    } else if (name === 'p') {
      if (lists.length > 0) text += ' '
      else flushParagraph()
    } else if (name === 'ul' || name === 'ol') {
      if (open) {
        if (lists.length === 0) {
          flushParagraph()
          blank()
        } else flushItem()
        lists.push({ ordered: name === 'ol', count: 0 })
      } else {
        flushItem()
        lists.pop()
        if (lists.length === 0) blank()
      }
    } else if (name === 'li') {
      flushItem()
      const list = lists[lists.length - 1]
      if (open && list !== undefined) list.count++
    } else if (name === 'table') {
      if (open) {
        if (tableDepth === 0) {
          if (lists.length > 0) flushItem()
          else flushParagraph()
          rows = []
        }
        tableDepth++
      } else {
        tableDepth = Math.max(0, tableDepth - 1)
        if (tableDepth === 0) flushTable()
      }
    } else if (name === 'br') {
      text += '\n'
    }
  }
  if (lists.length > 0) flushItem()
  else flushParagraph()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

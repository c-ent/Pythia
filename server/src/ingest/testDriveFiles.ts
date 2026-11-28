import ExcelJS, { type CellValue } from 'exceljs'
import { strToU8, zipSync } from 'fflate'

// Test-only helpers: build Drive-style Office files in memory, so no real
// document (and nothing personal) is ever committed as a fixture.

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type DocxBlock =
  | { heading: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { title: string }
  | { paragraph: string }
  | { bullet: string }
  | { table: string[][] }

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`
const para = (text: string, style?: string): string =>
  `<w:p>${style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${run(text)}</w:p>`
const bulletPara = (text: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`

function blockXml(block: DocxBlock): string {
  if ('heading' in block) return para(block.text, `Heading${block.heading}`)
  if ('title' in block) return para(block.title, 'Title')
  if ('bullet' in block) return bulletPara(block.bullet)
  if ('table' in block)
    return `<w:tbl>${block.table
      .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join('')}</w:tr>`)
      .join('')}</w:tbl>`
  return para(block.paragraph)
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

const headingStyles = [1, 2, 3, 4, 5, 6]
  .map(
    (level) =>
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`,
  )
  .join('')

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>${headingStyles}</w:styles>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`

/** A minimal `.docx` (Word or a Google Docs export) holding these blocks. */
export function docxFile(blocks: readonly DocxBlock[]): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${blocks.map(blockXml).join('')}</w:body></w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(STYLES),
    'word/numbering.xml': strToU8(NUMBERING),
  })
}

/** The first bytes of a PNG, enough for a file the extractor must skip. */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

/** A Compound File Binary header: what a password-protected Office file starts with. */
export const ENCRYPTED_OFFICE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])

const escapePdfText = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`)

/** A content stream drawing these lines with Helvetica, top to bottom; `[]` is a page with no text (a scan). */
const pageStream = (lines: readonly string[]): string =>
  lines.length === 0
    ? '0 0 m 100 100 l S'
    : `BT /F1 10 Tf 72 760 Td 12 TL ${lines.map((line) => `(${escapePdfText(line)}) '`).join(' ')} ET`

/**
 * A minimal PDF with one page per entry, each page holding those text lines.
 * `encrypted` adds a Standard security handler with an unknown password.
 */
export function pdfFile(pages: readonly (readonly string[])[], { encrypted = false } = {}): Uint8Array {
  const fontId = 3 + pages.length * 2
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  for (const [i, lines] of pages.entries()) {
    const stream = pageStream(lines)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  const encrypt = encrypted
    ? `/Encrypt << /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >> /ID [<${'ab'.repeat(16)}> <${'ab'.repeat(16)}>] `
    : ''
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encrypt}>>\nstartxref\n${xref}\n%%EOF\n`
  return strToU8(out)
}

/** A sheet for `xlsxFile`: its name and rows of cell values (`null` is an empty cell). */
export interface XlsxSheet {
  name: string
  rows: CellValue[][]
}

/** A `.xlsx` (Excel or a Google Sheets export) with these sheets, in order. */
export async function xlsxFile(sheets: readonly XlsxSheet[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sheet.name)
    sheet.rows.forEach((cells, r) => {
      cells.forEach((value, c) => {
        if (value !== null) worksheet.getCell(r + 1, c + 1).value = value
      })
    })
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** A slide for `pptxFile`: optional title, body paragraphs and speaker notes. */
export interface PptxSlide {
  title?: string
  body?: string[]
  notes?: string[]
}

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const drawingParagraphs = (lines: readonly string[]): string =>
  lines.map((line) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(line)}</a:t></a:r></a:p>`).join('')

const placeholderShape = (id: number, type: string | null, lines: readonly string[]): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${
    type === null ? '<p:ph idx="1"/>' : `<p:ph type="${type}"/>`
  }</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${drawingParagraphs(lines)}</p:txBody></p:sp>`

/**
 * A minimal `.pptx` (PowerPoint or a Google Slides export). Slide files are
 * numbered in reverse so only `presentation.xml` gives the right order; every
 * slide also carries a footer and slide-number placeholder.
 */
export function pptxFile(slides: readonly PptxSlide[]): Uint8Array {
  const files: Record<string, Uint8Array> = {}
  const count = slides.length
  const presRels: string[] = []
  const sldIds: string[] = []
  slides.forEach((slide, index) => {
    const n = count - index
    presRels.push(`<Relationship Id="rId${index + 10}" Type="${REL_NS}/slide" Target="slides/slide${n}.xml"/>`)
    sldIds.push(`<p:sldId id="${256 + index}" r:id="rId${index + 10}"/>`)
    const shapes = [
      slide.title === undefined ? '' : placeholderShape(2, index === 0 ? 'ctrTitle' : 'title', [slide.title]),
      slide.body === undefined ? '' : placeholderShape(3, null, slide.body),
      placeholderShape(4, 'ftr', ['Company confidential']),
      placeholderShape(5, 'sldNum', [String(index + 1)]),
    ].join('')
    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld ${P_NS}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`,
    )
    const slideRels = [`<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`]
    if (slide.notes !== undefined) {
      slideRels.push(`<Relationship Id="rId2" Type="${REL_NS}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/>`)
      const notesShapes = [
        placeholderShape(2, 'sldImg', []),
        placeholderShape(3, 'body', slide.notes),
        placeholderShape(4, 'sldNum', [String(index + 1)]),
      ].join('')
      files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${P_NS}><p:cSld><p:spTree>${notesShapes}</p:spTree></p:cSld></p:notes>`,
      )
    }
    files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels.join('')}</Relationships>`,
    )
  })
  files['ppt/presentation.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation ${P_NS}><p:sldIdLst>${sldIds.join('')}</p:sldIdLst></p:presentation>`,
  )
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${presRels.join('')}</Relationships>`,
  )
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  )
  return zipSync(files)
}

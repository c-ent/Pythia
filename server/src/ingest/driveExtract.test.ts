import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  docxHtmlToMarkdown,
  driveExtension,
  driveTitle,
  extractDriveFile,
  parseCsv,
  type DriveDocument,
  type DriveExtraction,
} from './driveExtract.js'
import { docxFile, ENCRYPTED_OFFICE_BYTES, pdfFile, PNG_BYTES, pptxFile, xlsxFile } from './testDriveFiles.js'

function documentOf(result: DriveExtraction): DriveDocument {
  if (result.kind !== 'document') throw new Error(`expected a document, got skipped: ${result.reason}`)
  return result.document
}

describe('driveExtension and driveTitle', () => {
  it('reads the extension in lower case and the title without it', () => {
    expect(driveExtension('Reports/Q3 Plan.DOCX')).toBe('.docx')
    expect(driveTitle('Reports/Q3 Plan.DOCX')).toBe('Q3 Plan')
    expect(driveExtension('Notes/README')).toBe('')
    expect(driveTitle('Notes/README')).toBe('README')
    expect(driveExtension('.hidden')).toBe('')
    expect(driveTitle('a/b.c/report.v2.txt')).toBe('report.v2')
  })
})

describe('extractDriveFile: .docx', () => {
  it('turns Word headings into heading_path sections', async () => {
    const bytes = docxFile([
      { paragraph: 'Intro before any heading.' },
      { heading: 1, text: 'Budget' },
      { paragraph: 'Rent is due on the first.' },
      { heading: 2, text: 'Groceries' },
      { paragraph: 'Oat milk and bread every week.' },
      { heading: 1, text: 'Travel' },
      { paragraph: 'Train tickets to Taichung.' },
    ])
    const doc = documentOf(await extractDriveFile('Finance/Household.docx', bytes, { minTokens: 1 }))
    expect(doc.title).toBe('Household')
    expect(doc.allowLlm).toBe(true)
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual([
      'Household',
      'Household > Budget',
      'Household > Budget > Groceries',
      'Household > Travel',
    ])
    const groceries = doc.chunks.find((chunk) => chunk.headingPath.endsWith('Groceries'))!
    expect(groceries.content).toContain('Oat milk and bread every week.')
    expect(groceries.embedText.startsWith('Household > Budget > Groceries\n\n')).toBe(true)
    expect(groceries.startLine).toBeNull()
    expect(doc.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3])
  })

  it('merges short sections like the vault chunker does by default', async () => {
    const bytes = docxFile([
      { heading: 1, text: 'Budget' },
      { paragraph: 'Rent.' },
      { heading: 2, text: 'Groceries' },
      { paragraph: 'Bread.' },
    ])
    const doc = documentOf(await extractDriveFile('Household.docx', bytes))
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]!.headingPath).toBe('Household > Budget')
    expect(doc.chunks[0]!.content).toContain('Bread.')
  })

  it('gives one section for a Doc with no headings', async () => {
    const bytes = docxFile([{ paragraph: 'First thought.' }, { paragraph: 'Second thought.' }])
    const doc = documentOf(await extractDriveFile('Ideas.docx', bytes))
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]!.headingPath).toBe('Ideas')
    expect(doc.chunks[0]!.content).toBe('First thought.\n\nSecond thought.')
  })

  it('maps the Google Docs Title style to a top heading and keeps lists and tables as text', async () => {
    const bytes = docxFile([
      { title: 'Trip plan' },
      { bullet: 'Book the hotel' },
      { bullet: 'Pack the charger' },
      { table: [['Day', 'City'], ['Mon', 'Tainan']] },
    ])
    const doc = documentOf(await extractDriveFile('Trip.docx', bytes))
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]!.headingPath).toBe('Trip > Trip plan')
    expect(doc.chunks[0]!.content).toContain('- Book the hotel\n- Pack the charger')
    expect(doc.chunks[0]!.content).toContain('| Day | City |')
    expect(doc.chunks[0]!.content).toContain('| Mon | Tainan |')
  })

  it('indexes a large Doc in full, split into many chunks (no size cap)', async () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => ({ paragraph: `Paragraph ${i} ${'word '.repeat(60)}` }))
    const doc = documentOf(await extractDriveFile('Big.docx', docxFile(paragraphs)))
    expect(doc.chunks.length).toBeGreaterThan(40)
    const all = doc.chunks.map((chunk) => chunk.content).join('\n')
    expect(all).toContain('Paragraph 0 ')
    expect(all).toContain('Paragraph 399 ')
  })

  it('skips an empty Doc, an encrypted file and a damaged one', async () => {
    expect(await extractDriveFile('Empty.docx', docxFile([]))).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(await extractDriveFile('Locked.docx', ENCRYPTED_OFFICE_BYTES)).toEqual({
      kind: 'skipped',
      reason: 'encrypted',
    })
    expect(await extractDriveFile('Broken.docx', strToU8('not a zip'))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
    expect(await extractDriveFile('Broken.docx', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
  })
})

describe('extractDriveFile: .pdf', () => {
  it('gives one Page N section per page with text', async () => {
    const bytes = pdfFile([['Quarterly report', 'Revenue went up.'], ['Costs went down.']])
    const doc = documentOf(await extractDriveFile('Work/Report.pdf', bytes))
    expect(doc.title).toBe('Report')
    expect(doc.allowLlm).toBe(true)
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual(['Report > Page 1', 'Report > Page 2'])
    expect(doc.chunks[0]!.content).toContain('Revenue went up.')
    expect(doc.chunks[1]!.content).toContain('Costs went down.')
    expect(doc.chunks[1]!.embedText.startsWith('Report > Page 2\n\n')).toBe(true)
    expect(doc.chunks[0]!.startLine).toBeNull()
  })

  it('splits a long page into ~300-500 token chunks that all cite that page', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i} ${'word '.repeat(15)}`)
    const doc = documentOf(await extractDriveFile('Long.pdf', pdfFile([long])))
    expect(doc.chunks.length).toBeGreaterThan(1)
    expect(new Set(doc.chunks.map((chunk) => chunk.headingPath))).toEqual(new Set(['Long > Page 1']))
    const all = doc.chunks.map((chunk) => chunk.content).join('\n')
    expect(all).toContain('Line 0 ')
    expect(all).toContain('Line 59 ')
  })

  it('leaves out pages without text and escapes text that reads as Markdown', async () => {
    const bytes = pdfFile([['# not a heading'], [], ['Last page.']])
    const doc = documentOf(await extractDriveFile('Mixed.pdf', bytes))
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual(['Mixed > Page 1', 'Mixed > Page 3'])
    expect(doc.chunks[0]!.content).toContain('\\# not a heading')
  })

  it('skips a scanned PDF, an encrypted one and a damaged one', async () => {
    expect(await extractDriveFile('Scan.pdf', pdfFile([[], []]))).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(await extractDriveFile('Locked.pdf', pdfFile([['secret']], { encrypted: true }))).toEqual({
      kind: 'skipped',
      reason: 'encrypted',
    })
    expect(await extractDriveFile('Broken.pdf', strToU8('not a pdf at all'))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
    expect(await extractDriveFile('Cut.pdf', pdfFile([['x']]).slice(0, 40))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
  })

  it('does not change the bytes it was given', async () => {
    const bytes = pdfFile([['Keep me.']])
    const copy = bytes.slice()
    await extractDriveFile('Keep.pdf', bytes)
    expect(bytes).toEqual(copy)
  })
})

describe('extractDriveFile: .xlsx', () => {
  it('gives one File > Sheet section per sheet, header row first', async () => {
    const bytes = await xlsxFile([
      { name: 'Budget', rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300]] },
      { name: 'Trips', rows: [['City', 'Month'], ['Tainan', 'May']] },
    ])
    const doc = documentOf(await extractDriveFile('Money/Household.xlsx', bytes))
    expect(doc.title).toBe('Household')
    expect(doc.allowLlm).toBe(true)
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual(['Household > Budget', 'Household > Trips'])
    expect(doc.chunks[0]!.content).toBe('| Item | Cost |\n| --- | --- |\n| Rent | 1200 |\n| Food | 300 |')
    expect(doc.chunks[1]!.embedText.startsWith('Household > Trips\n\n| City | Month |')).toBe(true)
    expect(doc.chunks[0]!.startLine).toBeNull()
    expect(doc.chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1])
  })

  it('repeats the header row at the top of every chunk of a long sheet', async () => {
    const rows = [['Name', 'Note'], ...Array.from({ length: 200 }, (_, i) => [`Row ${i}`, 'word '.repeat(12).trim()])]
    const doc = documentOf(await extractDriveFile('Log.xlsx', await xlsxFile([{ name: 'Entries', rows }])))
    expect(doc.chunks.length).toBeGreaterThan(2)
    for (const chunk of doc.chunks) {
      expect(chunk.headingPath).toBe('Log > Entries')
      expect(chunk.content.startsWith('| Name | Note |\n| --- | --- |\n')).toBe(true)
    }
    const all = doc.chunks.map((chunk) => chunk.content).join('\n')
    expect(all).toContain('| Row 0 |')
    expect(all).toContain('| Row 199 |')
    expect(all.match(/\| Row 57 \|/g)).toHaveLength(1)
  })

  it('gives no chunk for an empty sheet and skips a workbook with only empty sheets', async () => {
    const bytes = await xlsxFile([
      { name: 'Blank', rows: [] },
      { name: 'Data', rows: [['A'], ['1']] },
    ])
    const doc = documentOf(await extractDriveFile('Mixed.xlsx', bytes))
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual(['Mixed > Data'])
    expect(await extractDriveFile('Nothing.xlsx', await xlsxFile([{ name: 'Sheet1', rows: [] }]))).toEqual({
      kind: 'skipped',
      reason: 'empty',
    })
  })

  it('reads formulas as their cached values and keeps dates, booleans and rich text as text', async () => {
    const bytes = await xlsxFile([
      {
        name: 'Calc',
        rows: [
          ['Label', 'Value'],
          ['Total', { formula: 'SUM(1,2)', result: 3 }],
          ['Missing', { formula: '1/0', result: { error: '#DIV/0!' } }],
          ['Day', new Date(Date.UTC(2026, 10, 27))],
          ['Done', true],
          ['Styled', { richText: [{ text: 'bold ' }, { text: 'plain' }] }],
          ['Pipe', 'a|b'],
        ],
      },
    ])
    const content = documentOf(await extractDriveFile('Calc.xlsx', bytes)).chunks[0]!.content
    expect(content).toContain('| Total | 3 |')
    expect(content).not.toContain('SUM(')
    expect(content).toContain('| Missing | #DIV/0! |')
    expect(content).toContain('| Day | 2026-11-27 |')
    expect(content).toContain('| Done | true |')
    expect(content).toContain('| Styled | bold plain |')
    expect(content).toContain('| Pipe | a\\|b |')
  })

  it('skips an encrypted workbook and a damaged one', async () => {
    expect(await extractDriveFile('Locked.xlsx', ENCRYPTED_OFFICE_BYTES)).toEqual({ kind: 'skipped', reason: 'encrypted' })
    expect(await extractDriveFile('Broken.xlsx', strToU8('not a zip'))).toEqual({ kind: 'skipped', reason: 'unreadable' })
    expect(await extractDriveFile('Docx.xlsx', docxFile([{ paragraph: 'hi' }]))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
  })
})

describe('extractDriveFile: .csv', () => {
  it('gives one section with quoted commas, quotes and line breaks kept in their cells', async () => {
    const csv = '\uFEFFName,Address,Note\r\n"Lin, Mei","12 Main St, Taipei","said ""hi"""\r\nBo,"two\nlines",\r\n'
    const doc = documentOf(await extractDriveFile('Contacts.csv', strToU8(csv)))
    expect(doc.title).toBe('Contacts')
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]!.headingPath).toBe('Contacts')
    expect(doc.chunks[0]!.content).toBe(
      '| Name | Address | Note |\n| --- | --- | --- |\n| Lin, Mei | 12 Main St, Taipei | said "hi" |\n| Bo | two lines |  |',
    )
  })

  it('skips a blank CSV', async () => {
    expect(await extractDriveFile('blank.csv', strToU8(',,\n\n'))).toEqual({ kind: 'skipped', reason: 'empty' })
  })
})

describe('parseCsv', () => {
  it('handles a missing final newline and empty fields', () => {
    expect(parseCsv('a,,c\n1,2')).toEqual([
      ['a', '', 'c'],
      ['1', '2'],
    ])
  })
})

describe('extractDriveFile: .pptx', () => {
  const deck = pptxFile([
    { title: 'Roadmap', body: ['Ship Drive search', 'Then Slides'], notes: ['Mention the deadline'] },
    { title: 'Budget', body: ['Costs stay flat'] },
    { body: ['No title on this one'] },
    { title: 'Thanks' },
  ])

  it('gives one section per slide in presentation order, titles in heading_path', async () => {
    const doc = documentOf(await extractDriveFile('Talks/Deck.pptx', deck))
    expect(doc.title).toBe('Deck')
    expect(doc.allowLlm).toBe(true)
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual([
      'Deck > Roadmap',
      'Deck > Budget',
      'Deck > Slide 3',
      'Deck > Thanks',
    ])
    expect(doc.chunks[0]!.startLine).toBeNull()
    expect(doc.chunks[2]!.content).toContain('No title on this one')
  })

  it('includes speaker notes and leaves out footers and slide numbers', async () => {
    const doc = documentOf(await extractDriveFile('Deck.pptx', deck))
    const roadmap = doc.chunks[0]!.content
    expect(roadmap).toContain('Ship Drive search\nThen Slides')
    expect(roadmap).toContain('Speaker notes:\nMention the deadline')
    expect(doc.chunks.map((chunk) => chunk.content).join('\n')).not.toContain('Company confidential')
  })

  it('keeps a title-only slide findable by its title', async () => {
    const doc = documentOf(await extractDriveFile('Deck.pptx', deck))
    expect(doc.chunks[3]!.headingPath).toBe('Deck > Thanks')
    expect(doc.chunks[3]!.content).toBe('# Thanks\n\nThanks')
  })

  it('escapes slide text that reads as Markdown', async () => {
    const doc = documentOf(await extractDriveFile('Md.pptx', pptxFile([{ title: 'Intro', body: ['# not a heading'] }])))
    expect(doc.chunks.map((chunk) => chunk.headingPath)).toEqual(['Md > Intro'])
    expect(doc.chunks[0]!.content).toBe('# Intro\n\n\\# not a heading')
  })

  it('skips an empty deck, an encrypted one and a damaged one', async () => {
    expect(await extractDriveFile('Blank.pptx', pptxFile([{}, {}]))).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(await extractDriveFile('None.pptx', pptxFile([]))).toEqual({ kind: 'skipped', reason: 'empty' })
    expect(await extractDriveFile('Locked.pptx', ENCRYPTED_OFFICE_BYTES)).toEqual({ kind: 'skipped', reason: 'encrypted' })
    expect(await extractDriveFile('Broken.pptx', strToU8('not a zip'))).toEqual({ kind: 'skipped', reason: 'unreadable' })
    expect(await extractDriveFile('Docx.pptx', docxFile([{ paragraph: 'hi' }]))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
  })
})

describe('extractDriveFile: .md and .txt', () => {
  it('chunks Markdown with R3, keeping lines and llm: false frontmatter', async () => {
    const md = '---\nllm: false\n---\n# Plan\nBody text here.\n'
    const doc = documentOf(await extractDriveFile('Private/plan.md', strToU8(md)))
    expect(doc.title).toBe('plan')
    expect(doc.allowLlm).toBe(false)
    expect(doc.chunks).toEqual([
      expect.objectContaining({ headingPath: 'plan > Plan', startLine: 4, endLine: 5, content: '# Plan\nBody text here.' }),
    ])
  })

  it('reads a .txt file as one section', async () => {
    const doc = documentOf(await extractDriveFile('todo.txt', strToU8('call the bank\nrenew passport\n')))
    expect(doc.title).toBe('todo')
    expect(doc.chunks).toHaveLength(1)
    expect(doc.chunks[0]).toMatchObject({ headingPath: 'todo', startLine: 1, endLine: 2 })
  })

  it('skips a blank text file', async () => {
    expect(await extractDriveFile('blank.txt', strToU8('  \n\n'))).toEqual({ kind: 'skipped', reason: 'empty' })
  })
})

describe('extractDriveFile: non-documents', () => {
  it('skips images and other files with a reason', async () => {
    expect(await extractDriveFile('Photos/cat.png', PNG_BYTES)).toEqual({ kind: 'skipped', reason: 'not_document' })
    for (const path of ['song.mp3', 'clip.mp4', 'backup.zip', 'setup.exe', 'Form.gform', 'Sketch.gdraw', 'NOEXT']) {
      expect((await extractDriveFile(path, strToU8('x'))).kind).toBe('skipped')
    }
  })
})

describe('docxHtmlToMarkdown', () => {
  it('escapes document text that would read as Markdown structure', () => {
    const md = docxHtmlToMarkdown('<p># not a heading</p><p>```</p><p>---</p><h2>Real &amp; true</h2><p>a&nbsp;b &lt;c&gt; &#233;</p>')
    expect(md).toBe('\\# not a heading\n\n\\```\n\n\\---\n\n## Real & true\n\na b <c> é')
  })

  it('numbers ordered lists, nests sublists and keeps line breaks', () => {
    const md = docxHtmlToMarkdown('<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol><p>line<br />next</p>')
    expect(md).toBe('1. one\n  - sub\n2. two\n\nline\nnext')
  })

  it('drops empty headings, paragraphs and table rows', () => {
    expect(docxHtmlToMarkdown('<h1></h1><p> </p><table><tr><td></td></tr></table>')).toBe('')
  })
})

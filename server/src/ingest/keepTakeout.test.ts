import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { chunkMarkdown } from './markdownChunker.js'
import { KeepTakeoutError, MAX_NOTE_JSON_BYTES, keepNoteMarkdown, parseKeepTakeout, UNTITLED } from './keepTakeout.js'
import { keepJson, takeoutZip } from './testKeepTakeout.js'

describe('parseKeepTakeout', () => {
  it('reads title, text, labels, checklist, archive flag and edit time', () => {
    const zip = takeoutZip({
      'Groceries.json': keepJson({ labels: [{ name: 'home' }, { name: ' home ' }, { name: 'food' }] }),
      'Groceries.html': '<html>copy</html>',
      'Packing.json': keepJson({
        title: 'Packing',
        textContent: undefined,
        listContent: [
          { text: 'Passport', isChecked: true },
          { text: '  ', isChecked: false },
          { text: 'Charger', isChecked: false },
        ],
        isArchived: true,
      }),
      'photo.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    })
    const { notes, skipped } = parseKeepTakeout(zip)
    expect(notes.map((note) => note.path)).toEqual(['Keep/Groceries', 'Keep/Packing'])
    expect(notes[0]).toMatchObject({
      title: 'Groceries',
      text: 'Buy oat milk',
      labels: ['home', 'food'],
      checklist: [],
      archived: false,
    })
    expect(notes[0]?.editedAt?.toISOString()).toBe(new Date(1_732_000_000_000).toISOString())
    expect(notes[1]).toMatchObject({
      archived: true,
      checklist: [
        { text: 'Passport', checked: true },
        { text: 'Charger', checked: false },
      ],
    })
    expect(skipped).toEqual({ trashed: 0, empty: 0, invalid: 0, blocked: 0, tooLarge: 0 })
  })

  it('titles an untitled note from its first line, its checklist, or a fallback', () => {
    const long = 'x'.repeat(200)
    const { notes } = parseKeepTakeout(
      takeoutZip({
        'a.json': keepJson({ title: '', textContent: '\n  First line here\nsecond' }),
        'b.json': keepJson({ title: '', textContent: undefined, listContent: [{ text: 'Eggs', isChecked: false }] }),
        'c.json': keepJson({ title: '', textContent: long }),
        'd.json': keepJson({ title: 'Only a title', textContent: '' }),
      }),
    )
    expect(notes.map((note) => note.title)).toEqual(['First line here', 'Eggs', `${'x'.repeat(79)}…`, 'Only a title'])
    expect(UNTITLED).toBe('Untitled note')
  })

  it('skips trashed, empty, blocked, oversized and non-Keep JSON files', () => {
    const { notes, skipped } = parseKeepTakeout(
      takeoutZip({
        'keep.json': keepJson(),
        'trashed.json': keepJson({ isTrashed: true }),
        'empty.json': keepJson({ title: '', textContent: '   ', listContent: [] }),
        'credentials.json': keepJson({ title: 'Router' }),
        'huge.json': keepJson({ textContent: 'a'.repeat(MAX_NOTE_JSON_BYTES + 1) }),
        'broken.json': '{ not json',
        '/Takeout/archive_browser.json': JSON.stringify({ products: ['Keep'] }),
        '/__MACOSX/Takeout/Keep/._keep.json': 'junk',
      }),
    )
    expect(notes.map((note) => note.path)).toEqual(['Keep/keep'])
    expect(skipped).toEqual({ trashed: 1, empty: 1, invalid: 2, blocked: 1, tooLarge: 1 })
  })

  it('keeps two notes whose Takeout file names collide', () => {
    const { notes } = parseKeepTakeout(
      takeoutZip({ 'Note.json': keepJson({ title: 'One' }), '/takeout/Keep/Note.json': keepJson({ title: 'Two' }) }),
    )
    expect(notes.map((note) => note.path).sort()).toEqual(['Keep/Note', 'Keep/Note (2)'])
  })

  it('rejects a file that is not a zip', () => {
    expect(() => parseKeepTakeout(strToU8('hello'))).toThrow(KeepTakeoutError)
    expect(() => parseKeepTakeout(new Uint8Array())).toThrow('not a zip file')
  })

  it('rejects a corrupt zip', () => {
    const zip = takeoutZip({ 'a.json': keepJson() })
    expect(() => parseKeepTakeout(zip.slice(0, 40))).toThrow(KeepTakeoutError)
  })

  it('rejects a zip with no Keep notes in it', () => {
    const zip = takeoutZip({ '/Takeout/Drive/report.json': JSON.stringify({ name: 'report' }), 'readme.txt': 'hi' })
    expect(() => parseKeepTakeout(zip)).toThrow('No Google Keep notes found')
  })
})

describe('keepNoteMarkdown', () => {
  const base = { path: 'Keep/x', title: 'T', text: '', labels: [], checklist: [], archived: false, editedAt: null }

  it('puts text, checklist and labels into searchable Markdown', () => {
    const markdown = keepNoteMarkdown({
      ...base,
      text: 'Weekend trip',
      checklist: [
        { text: 'Tent', checked: true },
        { text: 'Stove', checked: false },
      ],
      labels: ['travel', 'summer'],
    })
    expect(markdown).toBe('Weekend trip\n\n- [x] Tent\n- [ ] Stove\n\nLabels: travel, summer')
  })

  it('indexes a title-only note by its title', () => {
    expect(keepNoteMarkdown({ ...base, title: 'Call the dentist' })).toBe('Call the dentist')
  })

  it('keeps text that starts with a horizontal rule instead of losing it as frontmatter', () => {
    const markdown = keepNoteMarkdown({ ...base, text: '---\nllm: true\n---\nstill text' })
    const chunks = chunkMarkdown('Keep/x.md', markdown, { title: 'T' }).chunks
    expect(chunks.map((chunk) => chunk.content).join('\n')).toContain('still text')
    expect(chunks.map((chunk) => chunk.content).join('\n')).toContain('llm: true')
  })
})

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createSofficeConverter,
  DRIVE_CONVERSIONS,
  extractDriveFileConverted,
  type OfficeConverter,
  type OfficeTarget,
} from './driveConvert.js'
import type { DriveDocument, DriveExtraction } from './driveExtract.js'
import { docxFile, pptxFile, xlsxFile } from './testDriveFiles.js'

function documentOf(result: DriveExtraction): DriveDocument {
  if (result.kind !== 'document') throw new Error(`expected a document, got skipped: ${result.reason}`)
  return result.document
}

const docx = docxFile([{ heading: 1, text: 'Minutes' }, { paragraph: 'We agreed on the plan.' }])
let xlsx: Uint8Array
const pptx = pptxFile([{ title: 'Kickoff', body: ['Goals for the year'] }])

beforeAll(async () => {
  xlsx = await xlsxFile([{ name: 'Costs', rows: [['Item', 'Cost'], ['Rent', 1200]] }])
})

/** A stand-in converter that returns a fixture of the requested format. */
const fixtureConverter = (): OfficeConverter & ReturnType<typeof vi.fn> =>
  vi.fn((_bytes: Uint8Array, _from: string, to: OfficeTarget) =>
    Promise.resolve(to === 'docx' ? docx : to === 'xlsx' ? xlsx : pptx),
  ) as unknown as OfficeConverter & ReturnType<typeof vi.fn>

describe('extractDriveFileConverted with a stubbed converter', () => {
  it('routes each old Office and OpenDocument format to the right extractor', async () => {
    const expected: Record<string, { target: OfficeTarget; heading: string }> = {
      '.doc': { target: 'docx', heading: 'Old > Minutes' },
      '.rtf': { target: 'docx', heading: 'Old > Minutes' },
      '.odt': { target: 'docx', heading: 'Old > Minutes' },
      '.xls': { target: 'xlsx', heading: 'Old > Costs' },
      '.ods': { target: 'xlsx', heading: 'Old > Costs' },
      '.ppt': { target: 'pptx', heading: 'Old > Kickoff' },
      '.odp': { target: 'pptx', heading: 'Old > Kickoff' },
    }
    expect(Object.keys(DRIVE_CONVERSIONS).sort()).toEqual(Object.keys(expected).sort())
    for (const [extension, { target, heading }] of Object.entries(expected)) {
      const converter = fixtureConverter()
      const input = new Uint8Array([1, 2, 3])
      const doc = documentOf(await extractDriveFileConverted(`Archive/Old${extension}`, input, { converter }))
      expect(converter).toHaveBeenCalledTimes(1)
      expect(converter).toHaveBeenCalledWith(input, extension, target)
      expect(doc.title).toBe('Old')
      expect(doc.chunks[0]!.headingPath).toBe(heading)
    }
  })

  it('reads an upper-case extension the same way', async () => {
    const converter = fixtureConverter()
    const doc = documentOf(await extractDriveFileConverted('LETTER.DOC', new Uint8Array([1]), { converter }))
    expect(converter).toHaveBeenCalledWith(expect.any(Uint8Array), '.doc', 'docx')
    expect(doc.title).toBe('LETTER')
  })

  it('never calls the converter for formats the extractors read directly', async () => {
    const converter = fixtureConverter()
    const doc = documentOf(await extractDriveFileConverted('New.docx', docx, { converter }))
    expect(doc.chunks[0]!.headingPath).toBe('New > Minutes')
    expect((await extractDriveFileConverted('cat.png', new Uint8Array([0x89]), { converter })).kind).toBe('skipped')
    expect(converter).not.toHaveBeenCalled()
  })

  it('skips the file as conversion_failed when the converter rejects', async () => {
    const converter: OfficeConverter = () => Promise.reject(new Error('timed out'))
    expect(await extractDriveFileConverted('Old.doc', new Uint8Array([1]), { converter })).toEqual({
      kind: 'skipped',
      reason: 'conversion_failed',
    })
  })

  it('skips converted output the extractor cannot read', async () => {
    const converter: OfficeConverter = () => Promise.resolve(new Uint8Array([1, 2, 3]))
    expect(await extractDriveFileConverted('Old.xls', new Uint8Array([1]), { converter })).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    })
  })
})

// A stand-in for `soffice`, run with node: it copies the input to the output
// file LibreOffice would write, unless the input asks it to fail, hang or
// write nothing. Each call appends its arguments, cwd and environment keys to
// calls.log next to the script.
const FAKE_SOFFICE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const log = path.join(path.dirname(fileURLToPath(import.meta.url)), 'calls.log')
const args = process.argv.slice(2)
appendFileSync(log, JSON.stringify({ event: 'start', args, cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n')
const to = args[args.indexOf('--convert-to') + 1]
const outDir = args[args.indexOf('--outdir') + 1]
const input = args[args.length - 1]
const bytes = readFileSync(input)
const mode = bytes.toString('latin1')
if (mode.startsWith('MODE:fail')) { process.stderr.write('Error: source file could not be loaded'); process.exit(3) }
if (mode.startsWith('MODE:hang')) setInterval(() => {}, 1000)
else {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
  if (!mode.startsWith('MODE:noout')) writeFileSync(path.join(outDir, path.basename(input, path.extname(input)) + '.' + to), bytes)
  appendFileSync(log, JSON.stringify({ event: 'end' }) + '\\n')
}
`

describe('createSofficeConverter', () => {
  let root: string
  let script: string
  let tempRoot: string
  let mirror: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'pythia-convert-test-'))
    script = path.join(root, 'fake-soffice.mjs')
    tempRoot = path.join(root, 'tmp')
    mirror = path.join(root, 'gdrive')
    await mkdir(tempRoot)
    await mkdir(path.join(mirror, 'Work'), { recursive: true })
    await writeFile(script, FAKE_SOFFICE)
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  const converter = (timeoutMs = 20_000): OfficeConverter =>
    createSofficeConverter({ command: process.execPath, prefixArgs: [script], timeoutMs, tempRoot })

  const calls = async (): Promise<{ event: string; args?: string[]; cwd?: string; env?: string[] }[]> => {
    const text = await readFile(path.join(root, 'calls.log'), 'utf8').catch(() => '')
    await rm(path.join(root, 'calls.log'), { force: true })
    return text
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { event: string })
  }

  it('converts in a temp dir outside the mirror, never naming the file or writing the mirror', async () => {
    const mirrored = path.join(mirror, 'Work', 'Secret plan.doc')
    await writeFile(mirrored, docx)
    const before = await readFile(mirrored)

    const doc = documentOf(
      await extractDriveFileConverted(mirrored, new Uint8Array(before), { converter: converter() }),
    )
    expect(doc.title).toBe('Secret plan')
    expect(doc.chunks[0]!.headingPath).toBe('Secret plan > Minutes')

    const [start] = await calls()
    expect(start!.args).toEqual(expect.arrayContaining(['--headless', '--convert-to', 'docx', '--outdir']))
    expect(start!.args!.at(-1)).toMatch(/input\.doc$/)
    expect(start!.args!.join(' ')).not.toContain('Secret plan')
    expect(start!.cwd!.startsWith(tempRoot)).toBe(true)
    expect(start!.args!.every((arg) => !arg.includes(mirror))).toBe(true)
    // Only PATH, HOME and LANG (plus what the OS adds) reach LibreOffice.
    expect(start!.env).not.toContain('DATABASE_URL')
    expect(start!.env).not.toContain('PYTHIA_GEMINI_API_KEY')

    expect(await readdir(mirror, { recursive: true })).toEqual(
      expect.arrayContaining([path.join('Work', 'Secret plan.doc')]),
    )
    expect((await readdir(mirror, { recursive: true })).length).toBe(2)
    expect(await readFile(mirrored)).toEqual(before)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('rejects on a non-zero exit, no output and a timeout, and cleans up each time', async () => {
    const convert = converter(1_000)
    await expect(convert(new TextEncoder().encode('MODE:fail'), '.doc', 'docx')).rejects.toThrow('exited with an error')
    await expect(convert(new TextEncoder().encode('MODE:noout'), '.ods', 'xlsx')).rejects.toThrow('wrote no output')
    await expect(convert(new TextEncoder().encode('MODE:hang'), '.ppt', 'pptx')).rejects.toThrow('timed out')
    expect(await readdir(tempRoot)).toEqual([])
    await calls()

    for (const mode of ['MODE:fail', 'MODE:hang']) {
      expect(
        await extractDriveFileConverted('Old.doc', new TextEncoder().encode(mode), { converter: convert }),
      ).toEqual({ kind: 'skipped', reason: 'conversion_failed' })
    }
    await calls()
  }, 30_000)

  it('runs one conversion at a time', async () => {
    const convert = converter()
    const results = await Promise.all([
      convert(new TextEncoder().encode('one'), '.doc', 'docx'),
      convert(new TextEncoder().encode('MODE:fail'), '.doc', 'docx').catch(() => null),
      convert(new TextEncoder().encode('three'), '.odt', 'docx'),
    ])
    expect(new TextDecoder().decode(results[0]!)).toBe('one')
    expect(results[1]).toBeNull()
    expect(new TextDecoder().decode(results[2]!)).toBe('three')
    const events = (await calls()).map((call) => call.event)
    // The failing call exits before writing `end`; the others never overlap.
    expect(events).toEqual(['start', 'end', 'start', 'start', 'end'])
  }, 30_000)

  it('refuses an extension that is not plain letters and digits', async () => {
    await expect(converter()(new Uint8Array([1]), '../x', 'docx')).rejects.toThrow('unsupported extension')
  })
})

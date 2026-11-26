import { unzipSync } from 'fflate'
import { z } from 'zod'
import { isBlockedPath } from '../security/secrets.js'

/**
 * Reads Google Keep notes out of a Takeout `.zip` (R12). Pure: no disk, no
 * database. Keep writes one `<note>.json` per note next to `.html` copies and
 * attachments; only the JSON files are decompressed, and a file counts as a
 * Keep note by its shape, not its folder name, because Takeout folder names
 * can differ between exports.
 */

/** A single note JSON is a few KB; anything far larger is not a note. */
export const MAX_NOTE_JSON_BYTES = 2 * 1024 * 1024
/** Uncompressed JSON across the whole zip, so a zip bomb cannot exhaust memory. */
export const MAX_TOTAL_JSON_BYTES = 256 * 1024 * 1024
export const MAX_NOTES = 50_000

export class KeepTakeoutError extends Error {
  override name = 'KeepTakeoutError'
}

export interface KeepChecklistItem {
  text: string
  checked: boolean
}

export interface KeepNote {
  /** Zip path without `Takeout/` and `.json`, e.g. `Keep/Shopping`. Stable across exports. */
  path: string
  /** Never empty: falls back to the first line of text, then `Untitled note`. */
  title: string
  text: string
  labels: string[]
  checklist: KeepChecklistItem[]
  archived: boolean
  editedAt: Date | null
}

export interface KeepSkipped {
  trashed: number
  /** No title, text or checklist items. */
  empty: number
  /** JSON files that are not valid Keep notes (other Takeout products, broken files). */
  invalid: number
  /** Names on the secrets blocklist (for example a note called `credentials`). */
  blocked: number
  /** JSON files above `MAX_NOTE_JSON_BYTES`. */
  tooLarge: number
}

export interface KeepTakeout {
  notes: KeepNote[]
  skipped: KeepSkipped
}

// Every Keep note JSON carries `isTrashed` and either `textContent` or
// `listContent`; that combination is what marks a file as a Keep note.
const noteSchema = z
  .object({
    title: z.string().default(''),
    textContent: z.string().optional(),
    listContent: z.array(z.object({ text: z.string().default(''), isChecked: z.boolean().default(false) })).optional(),
    labels: z.array(z.object({ name: z.string() })).default([]),
    isTrashed: z.boolean(),
    isArchived: z.boolean().default(false),
    userEditedTimestampUsec: z.number().optional(),
  })
  .refine((note) => note.textContent !== undefined || note.listContent !== undefined)

const JSON_ENTRY = /\.json$/i
const TITLE_FALLBACK_CHARS = 80
export const UNTITLED = 'Untitled note'

const notePathOf = (entry: string): string => entry.replace(/^Takeout\//i, '').replace(JSON_ENTRY, '')

function editedAt(usec: number | undefined): Date | null {
  if (usec === undefined || !Number.isFinite(usec) || usec <= 0) return null
  const date = new Date(Math.floor(usec / 1000))
  return Number.isNaN(date.getTime()) ? null : date
}

function titleOf(title: string, text: string, checklist: readonly KeepChecklistItem[]): string {
  const own = title.trim()
  if (own !== '') return own
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? checklist[0]?.text ?? ''
  if (firstLine === '') return UNTITLED
  return firstLine.length > TITLE_FALLBACK_CHARS ? `${firstLine.slice(0, TITLE_FALLBACK_CHARS - 1)}…` : firstLine
}

function unzipJson(bytes: Uint8Array, skipped: KeepSkipped): Record<string, Uint8Array> {
  // Local file header signature; checked first so a wrong file gets a clear error.
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new KeepTakeoutError('The upload is not a zip file')
  let total = 0
  let entries = 0
  let overBudget = false
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (!JSON_ENTRY.test(file.name) || file.name.startsWith('__MACOSX/')) return false
        if (file.originalSize > MAX_NOTE_JSON_BYTES) {
          skipped.tooLarge++
          return false
        }
        total += file.originalSize
        entries++
        if (total > MAX_TOTAL_JSON_BYTES || entries > MAX_NOTES) overBudget = true
        return !overBudget
      },
    })
  } catch {
    throw new KeepTakeoutError('The upload is not a readable zip file')
  }
  if (overBudget) throw new KeepTakeoutError('The zip holds more notes than one import accepts')
  return files
}

/**
 * Parses a Takeout zip. Throws `KeepTakeoutError` for a file that is not a
 * zip or holds no Keep notes, so the caller can reject it before touching
 * the existing Keep documents.
 */
export function parseKeepTakeout(bytes: Uint8Array): KeepTakeout {
  const skipped: KeepSkipped = { trashed: 0, empty: 0, invalid: 0, blocked: 0, tooLarge: 0 }
  const files = unzipJson(bytes, skipped)
  const decoder = new TextDecoder()
  const notes: KeepNote[] = []
  const seen = new Set<string>()
  let keepFiles = 0

  for (const entry of Object.keys(files).sort()) {
    const data = files[entry]
    if (data === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(decoder.decode(data))
    } catch {
      skipped.invalid++
      continue
    }
    const result = noteSchema.safeParse(parsed)
    if (!result.success) {
      skipped.invalid++
      continue
    }
    keepFiles++
    const note = result.data
    if (note.isTrashed) {
      skipped.trashed++
      continue
    }
    if (isBlockedPath(entry)) {
      skipped.blocked++
      continue
    }
    const text = (note.textContent ?? '').replace(/\r\n/g, '\n').trim()
    const checklist = (note.listContent ?? [])
      .map((item) => ({ text: item.text.trim(), checked: item.isChecked }))
      .filter((item) => item.text !== '')
    if (note.title.trim() === '' && text === '' && checklist.length === 0) {
      skipped.empty++
      continue
    }
    // Two Takeout parts can hold the same file name; keep both notes.
    let path = notePathOf(entry)
    for (let n = 2; seen.has(path); n++) path = `${notePathOf(entry)} (${n})`
    seen.add(path)
    notes.push({
      path,
      title: titleOf(note.title, text, checklist),
      text,
      labels: [...new Set(note.labels.map((label) => label.name.trim()).filter((name) => name !== ''))],
      checklist,
      archived: note.isArchived,
      editedAt: editedAt(note.userEditedTimestampUsec),
    })
  }

  if (keepFiles === 0) throw new KeepTakeoutError('No Google Keep notes found in this zip')
  return { notes, skipped }
}

/**
 * The note as Markdown for the chunker: text, then the checklist as task
 * items, then the labels, so all three are searchable. A note with only a
 * title is indexed by its title.
 */
export function keepNoteMarkdown(note: KeepNote): string {
  const parts: string[] = []
  if (note.text !== '') parts.push(note.text)
  if (note.checklist.length > 0) {
    parts.push(note.checklist.map((item) => `- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n'))
  }
  if (note.labels.length > 0) parts.push(`Labels: ${note.labels.join(', ')}`)
  if (parts.length === 0) parts.push(note.title)
  const body = parts.join('\n\n')
  // A leading `---` line would be read as frontmatter and dropped from the text.
  return body.startsWith('---') ? `\n${body}` : body
}

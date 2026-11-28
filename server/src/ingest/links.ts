import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { containsSecret } from '../security/secrets.js'
import { frontmatterTags, inlineTags } from './noteTags.js'

/**
 * Explicit links (R20, T68) for Obsidian and Keep notes: wikilinks, embeds,
 * Markdown links to other notes, tags and Keep labels, plus the note's own
 * frontmatter `aliases`, which other notes' links resolve by.
 *
 * Links are parsed only from text that is stored and already passed the
 * secrets scanner (the clean chunks), and from frontmatter values that pass
 * it too. Targets are stored as written; they are resolved when read
 * (`resolveLink`), against the documents stored at that moment, so the order
 * notes are indexed in, renames and deletions never leave a stale target.
 */

export type NoteLinkKind = 'wikilink' | 'embed' | 'markdown'
/** `alias` rows are names of the note itself, not edges. */
export type LinkKind = NoteLinkKind | 'tag' | 'label' | 'alias'

export const NOTE_LINK_KINDS: readonly NoteLinkKind[] = ['wikilink', 'embed', 'markdown']

export interface LinkWrite {
  kind: LinkKind
  /**
   * As written: the note name or path of a wikilink or embed (without
   * heading and alias), the decoded href of a Markdown link, the tag
   * (lower case, without `#`), the Keep label, or the alias.
   */
  target: string
  /** Lookup key: `targetKey(target)` for note links and aliases, the tag or lower-case label otherwise. */
  targetKey: string
  /** `[[Note#Heading]]` or `[text](Note.md#heading)`; null without one. */
  heading: string | null
  /** `[[Note|alias]]` or the text of a Markdown link; null without one. */
  display: string | null
}

/** Keeps one pathological note from writing an unbounded number of rows. */
export const MAX_LINKS_PER_DOCUMENT = 1000
const MAX_TARGET_CHARS = 500
const MAX_DISPLAY_CHARS = 500

/**
 * A comparable form of a note's link rows, in stored order: what
 * `IndexStore.getDocumentStates` reports as `linksKey`, so an indexer can
 * tell whether an unchanged note's stored links are current (or were never
 * written, before T68) without re-embedding it.
 */
export function linksKey(links: readonly Pick<LinkWrite, 'kind' | 'target' | 'heading' | 'display'>[]): string {
  return JSON.stringify(links.map((link) => [link.kind, link.target, link.heading, link.display]))
}

/** `linksKey` of a note with no link rows. */
export const NO_LINKS_KEY = linksKey([])

/** Wikilinks and embeds to these are attachments, not notes. */
const ATTACHMENT = /\.(?:png|jpe?g|gif|svg|webp|bmp|avif|heic|tiff?|ico|pdf|mp3|wav|ogg|m4a|flac|webm|mp4|mov|mkv|ogv|canvas|base)$/i
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INLINE_CODE = /`[^`\n]*`/g
const MD_EXTENSION = /\.md$/i

/** A note name or path as compared: NFC, trimmed, `/` separators, no `.md`, lower case. */
export function nameKey(name: string): string {
  return name.normalize('NFC').trim().replace(/\\/g, '/').replace(MD_EXTENSION, '').toLowerCase()
}

/** The stored lookup key of a note link or alias: the last path part of `nameKey`. */
export function targetKey(target: string): string {
  const key = nameKey(target)
  const slash = key.lastIndexOf('/')
  return slash === -1 ? key : key.slice(slash + 1)
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function wikilink(embed: boolean, inner: string): LinkWrite | null {
  // Inside a table the alias pipe is written `\|`.
  const text = inner.replace(/\\\|/g, '|')
  const pipe = text.indexOf('|')
  const left = pipe === -1 ? text : text.slice(0, pipe)
  const display = pipe === -1 ? '' : text.slice(pipe + 1).trim()
  const hash = left.indexOf('#')
  const target = (hash === -1 ? left : left.slice(0, hash)).trim()
  const heading = hash === -1 ? '' : left.slice(hash + 1).trim()
  // `[[#Heading]]` points into the same note.
  if (target === '' || target.length > MAX_TARGET_CHARS || ATTACHMENT.test(target)) return null
  return {
    kind: embed ? 'embed' : 'wikilink',
    target,
    targetKey: targetKey(target),
    // `#^id` is a block reference, not a heading.
    heading: heading === '' || heading.startsWith('^') ? null : clip(heading, MAX_DISPLAY_CHARS),
    display: display === '' ? null : clip(display, MAX_DISPLAY_CHARS),
  }
}

function markdownLink(text: string, rawHref: string): LinkWrite | null {
  const href = rawHref.startsWith('<') ? rawHref.slice(1, -1).trim() : rawHref
  if (URL_SCHEME.test(href) || href.startsWith('//')) return null
  const hash = href.indexOf('#')
  const target = decode(hash === -1 ? href : href.slice(0, hash)).trim()
  const heading = hash === -1 ? '' : decode(href.slice(hash + 1)).trim()
  // Only links to other notes: an in-page anchor or a link to any other file is not one.
  if (target === '' || !MD_EXTENSION.test(target) || target.length > MAX_TARGET_CHARS) return null
  return {
    kind: 'markdown',
    target,
    targetKey: targetKey(target),
    heading: heading === '' ? null : clip(heading, MAX_DISPLAY_CHARS),
    display: text.trim() === '' ? null : clip(text.trim(), MAX_DISPLAY_CHARS),
  }
}

/** Wikilinks, embeds and Markdown links in one text, outside fenced code blocks and inline code. */
export function noteLinksInText(text: string): LinkWrite[] {
  const out: LinkWrite[] = []
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line)
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null
      continue
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1]!
      continue
    }
    const plain = line.replace(INLINE_CODE, ' ')
    for (const match of plain.matchAll(WIKILINK)) {
      const link = wikilink(match[1] === '!', match[2] ?? '')
      if (link !== null) out.push(link)
    }
    // Wikilinks first, then blanked, so `[[a]](b)` is never read twice.
    for (const match of plain.replace(WIKILINK, ' ').matchAll(MARKDOWN_LINK)) {
      if (match[1] === '!') continue
      const link = markdownLink(match[2] ?? '', match[3] ?? '')
      if (link !== null) out.push(link)
    }
  }
  return out
}

/** Frontmatter `aliases` (or `alias`): a YAML list, or a comma-separated string. Empty when the YAML does not parse. */
export function frontmatterAliases(yaml: string): string[] {
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch {
    return []
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!/^alias(?:es)?$/i.test(key)) continue
    const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value]
    for (const item of items) {
      if (typeof item !== 'string' && typeof item !== 'number') continue
      const alias = String(item).trim()
      if (alias !== '' && alias.length <= MAX_TARGET_CHARS) out.push(alias)
    }
  }
  return out
}

export interface NoteLinkInput {
  /** Frontmatter YAML, or null when the note has none (Keep notes never do). */
  yaml: string | null
  /** The note's chunk contents that passed the secrets scanner. */
  contents: readonly string[]
  /** Keep labels. */
  labels?: readonly string[]
}

/**
 * Every link row of one note, deduplicated, at most `MAX_LINKS_PER_DOCUMENT`:
 * aliases first (so the cap never drops a name), then tags, labels and links.
 * Frontmatter values are not in any chunk, so each is scanned here and
 * dropped when it holds a secret.
 */
export function extractLinks(input: NoteLinkInput): LinkWrite[] {
  const out: LinkWrite[] = []
  const seen = new Set<string>()
  const add = (link: LinkWrite): void => {
    if (out.length >= MAX_LINKS_PER_DOCUMENT) return
    const key = JSON.stringify([link.kind, link.kind === 'tag' || link.kind === 'label' || link.kind === 'alias' ? link.targetKey : link.target, link.heading, link.display])
    if (seen.has(key)) return
    seen.add(key)
    out.push(link)
  }
  const clean = (value: string): boolean => !containsSecret(value)

  if (input.yaml !== null) {
    for (const alias of frontmatterAliases(input.yaml).filter(clean)) {
      add({ kind: 'alias', target: alias, targetKey: targetKey(alias), heading: null, display: null })
    }
  }
  const lines = input.contents.flatMap((content) => content.split(/\r?\n/))
  const tags = [...(input.yaml === null ? [] : frontmatterTags(input.yaml).filter(clean)), ...inlineTags(lines)]
  for (const tag of tags) add({ kind: 'tag', target: tag, targetKey: tag, heading: null, display: null })
  for (const raw of input.labels ?? []) {
    const label = raw.normalize('NFC').trim()
    if (label === '' || label.length > MAX_TARGET_CHARS || !clean(label)) continue
    add({ kind: 'label', target: label, targetKey: label.toLowerCase(), heading: null, display: null })
  }
  for (const content of input.contents) for (const link of noteLinksInText(content)) add(link)
  return out
}

/** A note a link can resolve to: every document of the linking note's source. */
export interface LinkNote {
  id: number
  path: string
  title: string
  aliases: readonly string[]
}

export interface NoteIndex<T extends LinkNote = LinkNote> {
  notes: readonly T[]
  byPath: Map<string, T[]>
  byTitle: Map<string, T[]>
  byAlias: Map<string, T[]>
}

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

export function buildNoteIndex<T extends LinkNote>(notes: readonly T[]): NoteIndex<T> {
  const index: NoteIndex<T> = { notes, byPath: new Map(), byTitle: new Map(), byAlias: new Map() }
  for (const note of notes) {
    push(index.byPath, nameKey(note.path), note)
    push(index.byTitle, nameKey(note.title), note)
    for (const alias of note.aliases) push(index.byAlias, nameKey(alias), note)
  }
  return index
}

/** The keys a link to this note can carry (`targetKey`): its file name, title and aliases. For finding backlink candidates. */
export function noteKeys(note: Pick<LinkNote, 'path' | 'title' | 'aliases'>): string[] {
  return [...new Set([note.path, note.title, ...note.aliases].map(targetKey).filter((key) => key !== ''))]
}

const folderOf = (notePath: string): string => {
  const slash = notePath.lastIndexOf('/')
  return slash === -1 ? '' : notePath.slice(0, slash)
}

/** Same folder as the linking note first, then the shorter path, then path order, so the choice is stable. */
function pick<T extends LinkNote>(candidates: readonly T[] | undefined, fromPath: string): T | null {
  if (candidates === undefined || candidates.length === 0) return null
  const folder = folderOf(fromPath)
  const rank = (note: T): number => (folderOf(note.path) === folder ? 0 : 1)
  return (
    [...candidates].sort(
      (a, b) => rank(a) - rank(b) || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )[0] ?? null
  )
}

/**
 * The note a link points to, or null for a ghost. By path, then title, then
 * aliases (R20). A Markdown link is first read relative to the linking
 * note's folder; a wikilink path is read from the vault root, or as the end
 * of a longer path. A bare name is matched by title (a vault note's title is
 * its file name), so two notes with the same name are decided by `pick`.
 */
export function resolveLink<T extends LinkNote>(
  index: NoteIndex<T>,
  fromPath: string,
  link: { kind: NoteLinkKind; target: string },
): T | null {
  const raw = link.target.normalize('NFC').trim().replace(/\\/g, '/')
  if (link.kind === 'markdown' && !raw.startsWith('/')) {
    const relative = path.posix.normalize(path.posix.join(folderOf(fromPath), raw))
    if (relative !== '..' && !relative.startsWith('../')) {
      const hit = pick(index.byPath.get(nameKey(relative)), fromPath)
      if (hit !== null) return hit
    }
  }
  const key = nameKey(path.posix.normalize(raw.replace(/^\/+/, '')))
  if (key.includes('/')) {
    const exact = pick(index.byPath.get(key), fromPath)
    if (exact !== null) return exact
    const suffix = pick(
      index.notes.filter((note) => nameKey(note.path).endsWith(`/${key}`)),
      fromPath,
    )
    if (suffix !== null) return suffix
  }
  return pick(index.byTitle.get(key), fromPath) ?? pick(index.byAlias.get(key), fromPath)
}

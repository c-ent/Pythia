import { parse as parseYaml } from 'yaml'

/**
 * Obsidian note tags (R16): frontmatter `tags` / `tag` and inline `#tag` in
 * the body. Tags are matched without regard to case, so they are kept lower
 * case, without `#` and without a trailing `/`.
 */

const TAG_BODY = /^[\p{L}\p{N}_/-]+$/u
const DIGITS_ONLY = /^\p{N}+$/u
// `#` at the start of a line or after a space or opening bracket; `# Heading`
// has a space after `#`, so it is never read as a tag.
const INLINE_TAG = /(^|[\s([{,;])#([\p{L}\p{N}_/-]+)/gu
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INLINE_CODE = /`[^`]*`/g
const TAGS_KEY_LINE = /^\s*tags?\s*:(.*)$/i
const LIST_ITEM = /^\s*-\s*(.*)$/

/**
 * The tag as stored and matched: trimmed, without leading `#` or trailing
 * `/`, lower case. Null when it is not an Obsidian tag: only letters, digits,
 * `_`, `-` and `/`, no empty `/` part, and not digits alone.
 */
export function normalizeTag(input: string): string | null {
  const tag = input.trim().replace(/^#+/, '').replace(/\/+$/, '').toLowerCase()
  if (tag === '' || !TAG_BODY.test(tag)) return null
  if (tag.split('/').some((part) => part === '')) return null
  if (DIGITS_ONLY.test(tag.replace(/\//g, ''))) return null
  return tag
}

/** True when `tag` is `rule` or nested under it: rule `private` covers `private/health`. */
export function tagCovers(tag: string, rule: string): boolean {
  return tag === rule || tag.startsWith(`${rule}/`)
}

function tagsFromText(text: string, out: string[]): void {
  for (const piece of text.replace(/[[\]"']/g, ' ').split(/[,\s]+/)) {
    const tag = normalizeTag(piece)
    if (tag !== null) out.push(tag)
  }
}

/** When the YAML does not parse, the `tags:` line and the list under it are still read. */
function fallbackFrontmatterTags(yaml: string, out: string[]): void {
  let inList = false
  for (const line of yaml.split(/\r?\n/)) {
    const key = TAGS_KEY_LINE.exec(line)
    if (key !== null) {
      tagsFromText(key[1] ?? '', out)
      inList = true
      continue
    }
    const item = inList ? LIST_ITEM.exec(line) : null
    if (item !== null) tagsFromText(item[1] ?? '', out)
    else inList = false
  }
}

/** Tags in frontmatter: `tags: [a, b]`, a YAML list, or `tags: a, b`; `#` is optional. */
export function frontmatterTags(yaml: string): string[] {
  const out: string[] = []
  let data: unknown
  try {
    data = parseYaml(yaml)
  } catch {
    // A YAML error elsewhere must not let a tagged note slip past a tag rule.
    fallbackFrontmatterTags(yaml, out)
    return out
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!/^tags?$/i.test(key)) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' || typeof item === 'number') tagsFromText(String(item), out)
    }
  }
  return out
}

/** Inline `#tag` in body lines, outside fenced code blocks and inline code. */
export function inlineTags(lines: readonly string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line)
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null
      continue
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1]!
      continue
    }
    for (const match of line.replace(INLINE_CODE, ' ').matchAll(INLINE_TAG)) {
      const tag = normalizeTag(match[2] ?? '')
      if (tag !== null) out.push(tag)
    }
  }
  return out
}

/** Every tag of a note, from frontmatter (or null when it has none) and body, deduplicated and sorted. */
export function noteTags(yaml: string | null, bodyLines: readonly string[]): string[] {
  const all = [...(yaml === null ? [] : frontmatterTags(yaml)), ...inlineTags(bodyLines)]
  return [...new Set(all)].sort()
}

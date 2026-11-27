/**
 * A remark plugin for the Obsidian syntax plain Markdown does not know:
 *
 * - Callouts (`> [!note] Title`, foldable with `-` or `+`) become a styled box,
 *   a `<details>` when foldable (`-` starts closed, `+` open).
 * - Wikilinks (`[[Note]]`, `[[Note#Heading|Alias]]`, `[[#Heading]]`) show their
 *   display text. A link to a heading in the same note jumps to it; a link to
 *   another note has no page here and stays text, like other relative links.
 * - Embeds (`![[file]]`) show as `[Embed: file]`; nothing is loaded.
 * - Headings get ids (`h-<slug>`), and `[text](#Heading)` links point at them.
 *
 * Everything is built as Markdown tree nodes, never raw HTML.
 */

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

const text = (value: string): MdNode => ({ type: 'text', value })

function plainText(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  return (node.children ?? []).map(plainText).join('')
}

/** Lowercase letters and digits joined by `-`, as in the heading ids below. */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/** The id of the first heading with this text (later ones get `-1`, `-2`, ...). */
export function headingId(heading: string): string {
  return `h-${headingSlug(heading) || 'section'}`
}

const CALLOUT_TONES: Record<string, 'info' | 'success' | 'warning' | 'danger'> = {
  note: 'info',
  info: 'info',
  todo: 'info',
  abstract: 'info',
  summary: 'info',
  tldr: 'info',
  tip: 'info',
  hint: 'info',
  important: 'info',
  question: 'info',
  help: 'info',
  faq: 'info',
  success: 'success',
  check: 'success',
  done: 'success',
  warning: 'warning',
  caution: 'warning',
  attention: 'warning',
  failure: 'danger',
  fail: 'danger',
  missing: 'danger',
  danger: 'danger',
  error: 'danger',
  bug: 'danger',
}

/** The color family of a callout type; `neutral` for example, quote and unknown types. */
export function calloutTone(type: string): string {
  return Object.hasOwn(CALLOUT_TONES, type) ? (CALLOUT_TONES[type] ?? 'neutral') : 'neutral'
}

const CALLOUT_MARKER = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/

function toCallout(quote: MdNode): void {
  const children = quote.children ?? []
  const first = children[0]
  if (first?.type !== 'paragraph') return
  const inline = first.children ?? []
  const lead = inline[0]
  if (lead?.type !== 'text' || lead.value === undefined) return
  const match = CALLOUT_MARKER.exec(lead.value)
  if (match === null) return

  const type = (match[1] ?? '').toLowerCase()
  const fold = match[2] ?? ''
  // The title is the rest of the marker's line; the body starts on the next line.
  const rest = [text(lead.value.slice(match[0].length)), ...inline.slice(1)]
  const title: MdNode[] = []
  let body: MdNode[] = []
  for (const [i, node] of rest.entries()) {
    if (node.type === 'break') {
      body = rest.slice(i + 1)
      break
    }
    const cut = node.type === 'text' ? (node.value ?? '').indexOf('\n') : -1
    if (cut !== -1) {
      const value = node.value ?? ''
      title.push(text(value.slice(0, cut)))
      body = [text(value.slice(cut + 1)), ...rest.slice(i + 1)]
      break
    }
    title.push(node)
  }

  const hasTitle = title.some((node) => plainText(node).trim() !== '')
  const titleText = type.charAt(0).toUpperCase() + type.slice(1)
  const titleNode: MdNode = {
    type: 'paragraph',
    children: hasTitle ? title : [text(titleText)],
    data: { hName: fold === '' ? 'p' : 'summary', hProperties: { className: ['callout-title'] } },
  }
  const hasBody = body.some((node) => plainText(node).trim() !== '' || node.type !== 'text')
  quote.children = [titleNode, ...(hasBody ? [{ type: 'paragraph', children: body }] : []), ...children.slice(1)]
  quote.data = {
    ...quote.data,
    hName: fold === '' ? 'div' : 'details',
    hProperties: {
      className: ['callout'],
      dataCallout: type,
      dataCalloutTone: calloutTone(type),
      ...(fold === '+' ? { open: true } : {}),
    },
  }
}

// Links this plugin made; their url is final.
const madeLinks = new WeakSet<MdNode>()

function wikilink(inner: string, embed: boolean): MdNode {
  const bar = inner.indexOf('|')
  const target = (bar === -1 ? inner : inner.slice(0, bar)).trim()
  const alias = bar === -1 ? '' : inner.slice(bar + 1).trim()
  if (embed) {
    return {
      type: 'obsidianEmbed',
      children: [text(`[Embed: ${target}]`)],
      data: { hName: 'span', hProperties: { className: ['text-muted'] } },
    }
  }
  const hash = target.indexOf('#')
  const page = (hash === -1 ? target : target.slice(0, hash)).trim()
  const sections = hash === -1 ? [] : target.slice(hash + 1).split('#').map((s) => s.trim()).filter((s) => s !== '')
  const section = sections.at(-1) ?? ''
  const named = page === '' ? section : section === '' ? page : `${page} > ${section}`
  const label = alias !== '' ? alias : named !== '' ? named : target
  // `#^block` references have no anchor here.
  const sameNote = page === '' && section !== '' && !section.startsWith('^')
  const link: MdNode = { type: 'link', url: sameNote ? `#${headingId(section)}` : target, children: [text(label)] }
  madeLinks.add(link)
  return link
}

const WIKILINK = /(!?)\[\[([^[\]\n]+)\]\]/g

function splitWikilinks(value: string): MdNode[] | null {
  const out: MdNode[] = []
  let last = 0
  for (const match of value.matchAll(WIKILINK)) {
    if (match.index > last) out.push(text(value.slice(last, match.index)))
    out.push(wikilink(match[2] ?? '', match[1] === '!'))
    last = match.index + match[0].length
  }
  if (out.length === 0) return null
  if (last < value.length) out.push(text(value.slice(last)))
  return out
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function walk(node: MdNode, ids: Map<string, number>): void {
  if (node.type === 'link') {
    // A Markdown link to a heading in this note: `[text](#Some%20Heading)`.
    const url = node.url ?? ''
    if (!madeLinks.has(node) && url.startsWith('#') && !url.startsWith('#^')) node.url = `#${headingId(decode(url.slice(1)))}`
    return
  }
  if (node.type === 'blockquote') toCallout(node)
  if (node.type === 'heading') {
    const base = headingId(plainText(node))
    const seen = ids.get(base) ?? 0
    ids.set(base, seen + 1)
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: seen === 0 ? base : `${base}-${seen}` } }
  }
  if (node.children === undefined) return
  node.children = node.children.flatMap((child) =>
    child.type === 'text' ? (splitWikilinks(child.value ?? '') ?? [child]) : [child],
  )
  for (const child of node.children) walk(child, ids)
}

export function remarkObsidian() {
  return (tree: object): void => {
    walk(tree as MdNode, new Map())
  }
}

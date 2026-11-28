import { describe, expect, it } from 'vitest'
import {
  buildNoteIndex,
  extractLinks,
  frontmatterAliases,
  linksKey,
  MAX_LINKS_PER_DOCUMENT,
  NO_LINKS_KEY,
  noteKeys,
  noteLinksInText,
  resolveLink,
  targetKey,
  type LinkNote,
} from './links.js'

const brief = (text: string) =>
  noteLinksInText(text).map(({ kind, target, heading, display }) => ({ kind, target, heading, display }))

describe('noteLinksInText', () => {
  it('reads wikilinks with heading and alias, and embeds', () => {
    expect(brief('See [[Project Plan#Goals|the goals]] and ![[Diagram Note]].')).toEqual([
      { kind: 'wikilink', target: 'Project Plan', heading: 'Goals', display: 'the goals' },
      { kind: 'embed', target: 'Diagram Note', heading: null, display: null },
    ])
  })

  it('skips same-note headings, block references as headings, and attachments', () => {
    expect(brief('[[#Local]] [[Other#^abc123]] ![[photo.png]] [[scan.PDF]]')).toEqual([
      { kind: 'wikilink', target: 'Other', heading: null, display: null },
    ])
  })

  it('reads the escaped alias pipe used inside tables', () => {
    expect(brief('| [[Note\\|Shown]] |')).toEqual([{ kind: 'wikilink', target: 'Note', heading: null, display: 'Shown' }])
  })

  it('reads Markdown links to notes only, decoding the href', () => {
    expect(
      brief(
        '[Plan](sub/My%20Plan.md#Next%20Steps) [site](https://example.com/a.md) [pic](img.png) [anchor](#top) ![img](x.md) [angle](<Some Note.md> "t")',
      ),
    ).toEqual([
      { kind: 'markdown', target: 'sub/My Plan.md', heading: 'Next Steps', display: 'Plan' },
      { kind: 'markdown', target: 'Some Note.md', heading: null, display: 'angle' },
    ])
  })

  it('ignores fenced code blocks and inline code', () => {
    // A shorter run does not close a longer fence.
    const text = ['before [[A]]', '````', '[[InFence]]', '```', 'still [[InFence2]]', '````', '`[[Inline]]` after [[B]]'].join('\n')
    expect(brief(text).map((link) => link.target)).toEqual(['A', 'B'])
  })

  it('closes a fence only with the same character and at least its length', () => {
    const text = ['~~~~', '```', '[[Hidden]]', '~~~', '[[Hidden2]]', '~~~~', '[[Shown]]'].join('\n')
    expect(brief(text).map((link) => link.target)).toEqual(['Shown'])
  })
})

describe('frontmatterAliases', () => {
  it('reads a list, a comma-separated string, and numbers', () => {
    expect(frontmatterAliases('aliases:\n  - One\n  - 42\n')).toEqual(['One', '42'])
    expect(frontmatterAliases('alias: First, Second')).toEqual(['First', 'Second'])
  })

  it('returns nothing for broken or non-mapping YAML', () => {
    expect(frontmatterAliases('aliases: [unclosed')).toEqual([])
    expect(frontmatterAliases('- just\n- a list')).toEqual([])
  })
})

describe('extractLinks', () => {
  it('puts aliases first, then labels and links, deduplicated', () => {
    const links = extractLinks({
      yaml: 'aliases: [Nick]',
      contents: ['[[Target]] and [[Target]] again', 'then [[Target|other]]'],
      labels: ['Work', ' work '],
    })
    expect(links.map(({ kind, target, display }) => [kind, target, display])).toEqual([
      ['alias', 'Nick', null],
      ['label', 'Work', null],
      ['wikilink', 'Target', null],
      ['wikilink', 'Target', 'other'],
    ])
    expect(links.find((link) => link.kind === 'label')?.targetKey).toBe('work')
  })

  it('drops frontmatter aliases and labels that hold a secret', () => {
    // Assembled at runtime so the file never holds a literal token (see secrets.test.ts).
    const leaked = ['gh', 'p_', 'A1b2C3d4E5'.repeat(4)].join('')
    const links = extractLinks({ yaml: `aliases: [${leaked}, Safe]`, contents: [], labels: [leaked] })
    expect(links.map((link) => link.target)).toEqual(['Safe'])
  })

  it('stops at the per-document cap', () => {
    const contents = [Array.from({ length: MAX_LINKS_PER_DOCUMENT + 50 }, (_, i) => `[[N${i}]]`).join(' ')]
    expect(extractLinks({ yaml: null, contents })).toHaveLength(MAX_LINKS_PER_DOCUMENT)
  })
})

describe('linksKey and targetKey', () => {
  it('compares links in order and has a fixed empty form', () => {
    expect(NO_LINKS_KEY).toBe('[]')
    const a = { kind: 'wikilink' as const, target: 'A', heading: null, display: null }
    const b = { ...a, target: 'B' }
    expect(linksKey([a, b])).not.toBe(linksKey([b, a]))
  })

  it('keys a target by its last path part, without .md, in lower case', () => {
    expect(targetKey(' Folder\\Sub/My Note.MD ')).toBe('my note')
    expect(noteKeys({ path: 'a/Note.md', title: 'Note', aliases: ['Alt', ''] })).toEqual(['note', 'alt'])
  })
})

describe('resolveLink', () => {
  const notes: LinkNote[] = [
    { id: 1, path: 'Plan.md', title: 'Plan', aliases: [] },
    { id: 2, path: 'work/Plan.md', title: 'Plan', aliases: [] },
    { id: 3, path: 'work/deep/Spec.md', title: 'Spec', aliases: ['Specification'] },
    { id: 4, path: 'Home.md', title: 'Home', aliases: [] },
  ]
  const index = buildNoteIndex(notes)
  const at = (fromPath: string, kind: 'wikilink' | 'markdown', target: string) =>
    resolveLink(index, fromPath, { kind, target })?.id ?? null

  it('prefers a same-folder note for a duplicate name, then the shorter path', () => {
    expect(at('work/Notes.md', 'wikilink', 'Plan')).toBe(2)
    expect(at('Home.md', 'wikilink', 'Plan')).toBe(1)
    expect(at('other/X.md', 'wikilink', 'plan')).toBe(1)
  })

  it('resolves paths exactly or as the end of a longer path', () => {
    expect(at('Home.md', 'wikilink', 'work/Plan')).toBe(2)
    expect(at('Home.md', 'wikilink', 'deep/Spec')).toBe(3)
  })

  it('resolves Markdown links relative to the linking note, and by alias', () => {
    expect(at('work/deep/Spec.md', 'markdown', '../Plan.md')).toBe(2)
    // A path that leaves the vault root is a ghost.
    expect(at('Home.md', 'markdown', '../Plan.md')).toBeNull()
    expect(at('Home.md', 'markdown', 'work/Plan.md')).toBe(2)
    expect(at('Home.md', 'wikilink', 'specification')).toBe(3)
  })

  it('returns null for a ghost', () => {
    expect(at('Home.md', 'wikilink', 'Missing')).toBeNull()
  })
})

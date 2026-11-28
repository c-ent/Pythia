import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DocumentBody } from './DocumentBody'
import { hasNoteLinks, linkTargets, noteLinkKey } from './noteLinks'

describe('noteLinkKey', () => {
  it('drops the heading and .md, decodes, and compares case-insensitively', () => {
    expect(noteLinkKey('Other Note#Part')).toBe('other note')
    expect(noteLinkKey('Kitchen/Index%20page.md')).toBe('kitchen/index page')
    expect(noteLinkKey('Kitchen\\Index page.MD')).toBe('kitchen/index page')
    expect(noteLinkKey('  Café ')).toBe(noteLinkKey('Café'))
    expect(noteLinkKey('100%')).toBe('100%')
  })
})

describe('linkTargets', () => {
  it('maps each written target to its document, a ghost to null, and lets a resolved one win', () => {
    const targets = linkTargets([
      { target: 'Bread', heading: null, display: null, documentId: 45 },
      { target: 'Ghost', heading: null, display: null, documentId: null },
      { target: 'Twice', heading: null, display: null, documentId: null },
      { target: 'twice', heading: 'H', display: null, documentId: 9 },
      { target: '', heading: null, display: null, documentId: 1 },
    ])
    expect([...targets]).toEqual([
      ['bread', 45],
      ['ghost', null],
      ['twice', 9],
    ])
  })
})

describe('hasNoteLinks', () => {
  it('is true for Obsidian and Keep only', () => {
    expect(hasNoteLinks('obsidian')).toBe(true)
    expect(hasNoteLinks('keep')).toBe(true)
    expect(hasNoteLinks('repo')).toBe(false)
    expect(hasNoteLinks('gdrive')).toBe(false)
  })
})

describe('DocumentBody note links', () => {
  const doc = { content: 'See [[Ünïcode Note]], [[Ghost]] and [web](https://example.com).', language: 'markdown', source: { kind: 'obsidian', name: 'vault' } } as const

  it('links a resolved note even when the URL is percent-encoded, and mutes a ghost', () => {
    render(
      <DocumentBody
        doc={doc}
        targets={linkTargets([
          { target: 'Ünïcode Note', heading: null, display: null, documentId: 3 },
          { target: 'Ghost', heading: null, display: null, documentId: null },
        ])}
      />,
    )
    expect(screen.getByRole('link', { name: 'Ünïcode Note' }).getAttribute('href')).toBe('/doc/3')
    expect(screen.getByText('Ghost').className).toContain('text-muted')
    expect(screen.getByRole('link', { name: 'web' }).getAttribute('target')).toBe('_blank')
  })

  it('keeps note links as text without targets', () => {
    render(<DocumentBody doc={doc} />)
    expect(screen.getByText('Ünïcode Note').tagName).toBe('SPAN')
    expect(screen.getByText('Ghost').className).toContain('text-accent-ink')
  })
})

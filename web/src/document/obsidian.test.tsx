import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DocumentBody } from './DocumentBody'
import { calloutTone, headingId } from './obsidian'

const renderNote = (content: string) =>
  render(<DocumentBody doc={{ content, language: 'markdown', source: { kind: 'obsidian', name: 'vault' } }} />)

describe('Obsidian callouts', () => {
  it('renders a folded callout as closed details with its title', () => {
    const { container } = renderNote('> [!example]- Worked example\n> The body text.')
    const details = container.querySelector('details.callout')
    expect(details).not.toBeNull()
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.getAttribute('data-callout')).toBe('example')
    expect(details?.getAttribute('data-callout-tone')).toBe('neutral')
    expect(details?.querySelector('summary')?.textContent).toBe('Worked example')
    expect(details?.textContent).toContain('The body text.')
    expect(container.textContent).not.toContain('[!')
    expect(container.querySelector('blockquote')).toBeNull()
  })

  it('opens a + callout and names an untitled one after its type', () => {
    const { container } = renderNote('> [!tip]+\n> Body')
    const details = container.querySelector('details.callout')
    expect(details?.hasAttribute('open')).toBe(true)
    expect(details?.querySelector('summary')?.textContent).toBe('Tip')
  })

  it('renders a callout that cannot fold as a box', () => {
    const { container } = renderNote('> [!WARNING]\n> Careful with **this**.')
    const box = container.querySelector('div.callout')
    expect(box?.getAttribute('data-callout')).toBe('warning')
    expect(box?.getAttribute('data-callout-tone')).toBe('warning')
    expect(box?.querySelector('p.callout-title')?.textContent).toBe('Warning')
    expect(box?.querySelector('strong')?.textContent).toBe('this')
    expect(container.querySelector('details')).toBeNull()
  })

  it('leaves a plain quote a quote', () => {
    const { container } = renderNote('> Just a quote [not a marker]')
    expect(container.querySelector('blockquote')?.textContent.trim()).toBe('Just a quote [not a marker]')
    expect(container.querySelector('.callout')).toBeNull()
  })

  it('maps types to tones', () => {
    expect(calloutTone('bug')).toBe('danger')
    expect(calloutTone('done')).toBe('success')
    expect(calloutTone('note')).toBe('info')
    expect(calloutTone('example')).toBe('neutral')
    expect(calloutTone('constructor')).toBe('neutral')
  })
})

describe('Obsidian links', () => {
  const note = [
    '# Setup Steps',
    '',
    'See [[#Setup Steps]], [[Other Note|the other note]], [[Other Note#Part]], [jump](#Setup%20Steps) and ![[diagram.png]].',
  ].join('\n')

  it('shows wikilinks as their text and links headings in the same note', () => {
    const { container } = renderNote(note)
    expect(container.textContent).not.toContain('[[')
    expect(screen.getByRole('heading', { name: 'Setup Steps' }).id).toBe('h-setup-steps')
    const links = screen.getAllByRole('link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Setup Steps', '#h-setup-steps'],
      ['jump', '#h-setup-steps'],
    ])
    expect(screen.getByText('the other note').tagName).toBe('SPAN')
    expect(screen.getByText('Other Note > Part').tagName).toBe('SPAN')
    expect(screen.getByText('[Embed: diagram.png]')).toBeTruthy()
  })

  it('scrolls to the heading without changing the URL', () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      renderNote(note)
      const before = window.location.href
      const heading = screen.getByRole('heading', { name: 'Setup Steps' })
      expect(fireEvent.click(screen.getByRole('link', { name: 'Setup Steps' }))).toBe(false)
      expect(scroll).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(heading)
      expect(window.location.href).toBe(before)
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
  })

  it('gives repeated headings distinct ids', () => {
    renderNote('# Notes\n\n# Notes')
    expect(screen.getAllByRole('heading').map((h) => h.id)).toEqual(['h-notes', 'h-notes-1'])
  })

  it('slugs heading text', () => {
    expect(headingId('Ünïcode & Stuff!')).toBe('h-ünïcode-stuff')
    expect(headingId('!!!')).toBe('h-section')
  })
})

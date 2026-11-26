import { describe, expect, it } from 'vitest'
import { obsidianUrl } from './format'

const doc = (kind: string, path = 'Projects/Pythia plan.md') => ({ source: { kind }, path })

describe('obsidianUrl', () => {
  it('opens the note in the named vault, with both parts encoded', () => {
    expect(obsidianUrl('My Notes', doc('obsidian'))).toBe(
      'obsidian://open?vault=My%20Notes&file=Projects%2FPythia%20plan.md',
    )
  })

  it('trims the vault name', () => {
    expect(obsidianUrl('  Notes ', doc('obsidian', 'a.md'))).toBe('obsidian://open?vault=Notes&file=a.md')
  })

  it('is null without a vault name', () => {
    expect(obsidianUrl('', doc('obsidian'))).toBeNull()
    expect(obsidianUrl('   ', doc('obsidian'))).toBeNull()
  })

  it('is null for repo files and Keep notes', () => {
    expect(obsidianUrl('Notes', doc('repo'))).toBeNull()
    expect(obsidianUrl('Notes', doc('keep'))).toBeNull()
  })

  it('is null without a path', () => {
    expect(obsidianUrl('Notes', doc('obsidian', ''))).toBeNull()
  })
})

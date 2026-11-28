import { describe, expect, it } from 'vitest'
import { askInputSchema, documentLookupSchema, recentInputSchema, searchInputSchema } from './schemas.js'

// T55: `gdrive` is a source filter everywhere search, Ask, `/mcp` and recent
// changes take one; `work` never is (R2).
describe('source kind filters', () => {
  it('accepts gdrive in search and ask', () => {
    expect(searchInputSchema.parse({ query: 'budget', sources: ['gdrive'] }).sources).toEqual(['gdrive'])
    expect(askInputSchema.parse({ question: 'budget', sources: ['gdrive', 'obsidian'] }).sources).toEqual([
      'gdrive',
      'obsidian',
    ])
  })

  it('accepts gdrive for document lookup and recent changes', () => {
    expect(documentLookupSchema.parse({ source: 'gdrive', path: 'Reports/Q3.docx' }).source).toBe('gdrive')
    expect(recentInputSchema.parse({ source: 'gdrive' }).source).toBe('gdrive')
  })

  it('accepts every searchable kind at once', () => {
    const all = ['obsidian', 'keep', 'repo', 'chat', 'gdrive']
    expect(searchInputSchema.parse({ query: 'x', sources: all }).sources).toEqual(all)
  })

  it('rejects work and unknown kinds', () => {
    expect(searchInputSchema.safeParse({ query: 'x', sources: ['work'] }).success).toBe(false)
    expect(askInputSchema.safeParse({ question: 'x', sources: ['drive'] }).success).toBe(false)
    expect(documentLookupSchema.safeParse({ source: 'work', path: 'a' }).success).toBe(false)
  })
})

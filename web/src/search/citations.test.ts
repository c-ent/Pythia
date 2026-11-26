import { describe, expect, it } from 'vitest'
import { engineNote, splitCitations } from './citations'

const known = new Set([1, 2, 3])

describe('splitCitations', () => {
  it('splits single and grouped markers into citations', () => {
    expect(splitCitations('One [1], two [2, 3].', known)).toEqual([
      { kind: 'text', text: 'One ' },
      { kind: 'cite', n: 1 },
      { kind: 'text', text: ', two ' },
      { kind: 'cite', n: 2 },
      { kind: 'cite', n: 3 },
      { kind: 'text', text: '.' },
    ])
  })

  it('leaves unknown numbers, partly unknown groups and non-numeric brackets as text', () => {
    expect(splitCitations('See [9], [1, 9] and [note](x).', known)).toEqual([
      { kind: 'text', text: 'See [9], [1, 9] and [note](x).' },
    ])
  })

  it('handles markers at the edges and back to back', () => {
    expect(splitCitations('[1][2]', known)).toEqual([
      { kind: 'cite', n: 1 },
      { kind: 'cite', n: 2 },
    ])
  })

  it('returns plain text when there are no markers', () => {
    expect(splitCitations('No sources say that.', known)).toEqual([{ kind: 'text', text: 'No sources say that.' }])
    expect(splitCitations('', known)).toEqual([])
  })
})

describe('engineNote', () => {
  it('says nothing for a plain Gemini answer and counts withheld matches', () => {
    expect(engineNote({ engine: 'gemini', fallbacks: [], withheld: 0 })).toBeNull()
    expect(engineNote({ engine: 'gemini', fallbacks: [], withheld: 1 })).toBe('1 local-only match was kept from Gemini.')
  })

  it('explains why the local model answered', () => {
    expect(engineNote({ engine: 'ollama', fallbacks: ['all_private'], withheld: 0 })).toMatch(/Every match is local only/)
    expect(engineNote({ engine: 'ollama', fallbacks: ['gemini_failed'], withheld: 0 })).toMatch(/Gemini didn’t answer/)
    expect(engineNote({ engine: 'ollama', fallbacks: ['gemini_unconfigured'], withheld: 0 })).toMatch(/isn’t set up/)
  })

  it('explains a retrieval-only answer', () => {
    expect(engineNote({ engine: 'retrieval', fallbacks: ['gemini_failed', 'ollama_failed'], withheld: 0 })).toMatch(
      /couldn’t answer right now/,
    )
    expect(engineNote({ engine: 'retrieval', fallbacks: ['all_private', 'ollama_unconfigured'], withheld: 0 })).toMatch(
      /Every match is local only/,
    )
    expect(
      engineNote({ engine: 'retrieval', fallbacks: ['gemini_unconfigured', 'ollama_unconfigured'], withheld: 0 }),
    ).toMatch(/No AI model is set up/)
  })
})

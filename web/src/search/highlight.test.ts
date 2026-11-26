import { describe, expect, it } from 'vitest'
import { splitHighlights } from './highlight'

const join = (text: string, highlights: Array<[number, number]>) =>
  splitHighlights({ text, highlights })
    .map((s) => (s.marked ? `[${s.text}]` : s.text))
    .join('')

describe('splitHighlights', () => {
  it('marks the given ranges', () => {
    expect(join('Private knowledge server', [[8, 17]])).toBe('Private [knowledge] server')
    expect(join('a b c', [[0, 1], [4, 5]])).toBe('[a] b [c]')
  })

  it('returns plain text when nothing is highlighted', () => {
    expect(splitHighlights({ text: 'plain', highlights: [] })).toEqual([{ text: 'plain', marked: false }])
    expect(splitHighlights({ text: '', highlights: [[0, 3]] })).toEqual([])
  })

  it('sorts, merges overlaps and clamps bad ranges without losing text', () => {
    expect(join('abcdefgh', [[5, 7], [1, 3]])).toBe('a[bc]de[fg]h')
    expect(join('abcdefgh', [[1, 5], [3, 7]])).toBe('a[bcde][fg]h')
    expect(join('abcdefgh', [[-4, 2], [6, 99]])).toBe('[ab]cdef[gh]')
    expect(join('abcdefgh', [[4, 4], [5, 2], [Number.NaN, 3]])).toBe('[abc]defgh')
  })

  it('never changes the text itself', () => {
    const text = 'Ünïcode 🙂 text'
    for (const highlights of [[[0, 3]], [[8, 10]], [[2, 50]]] as Array<Array<[number, number]>>) {
      expect(splitHighlights({ text, highlights }).map((s) => s.text).join('')).toBe(text)
    }
  })
})

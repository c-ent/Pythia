import { describe, expect, it } from 'vitest'
import { parseHeadline } from './searchStore.js'

const S = '\u0001'
const E = '\u0002'

describe('parseHeadline', () => {
  it('returns plain text and match offsets', () => {
    expect(parseHeadline(`a ${S}bb${E} c ${S}d${E}`)).toEqual({ text: 'a bb c d', highlights: [[2, 4], [7, 8]] })
  })

  it('drops empty and unclosed markers safely', () => {
    expect(parseHeadline(`${S}${E}x ${S}yz`)).toEqual({ text: 'x yz', highlights: [[2, 4]] })
  })

  it('counts offsets in UTF-16 units', () => {
    const { text, highlights } = parseHeadline(`😀 ${S}ok${E}`)
    expect(text.slice(highlights[0][0], highlights[0][1])).toBe('ok')
  })
})

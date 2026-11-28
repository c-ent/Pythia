import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { headingTrail, resultCount, searchErrorMessage, sourceLabel } from './format'

describe('search formatting', () => {
  it('drops the note title from the heading path', () => {
    expect(headingTrail({ title: 'Pythia', headingPath: 'Pythia > Goals > Search' })).toBe('Goals › Search')
    expect(headingTrail({ title: 'Pythia', headingPath: 'Setup' })).toBe('Setup')
    expect(headingTrail({ title: 'Pythia', headingPath: 'Pythia' })).toBeNull()
    expect(headingTrail({ title: 'Pythia', headingPath: '  ' })).toBeNull()
  })

  it('labels sources', () => {
    expect(sourceLabel({ kind: 'repo', name: 'kitchen-app' })).toBe('kitchen-app')
    expect(sourceLabel({ kind: 'obsidian', name: 'vault' })).toBe('Obsidian')
    expect(sourceLabel({ kind: 'keep', name: 'takeout' })).toBe('Keep')
    expect(sourceLabel({ kind: 'gdrive', name: 'gdrive' })).toBe('Drive')
  })

  it('counts results', () => {
    expect(resultCount(1)).toBe('1 result')
    expect(resultCount(0)).toBe('0 results')
    expect(resultCount(12)).toBe('12 results')
  })

  it('maps errors without echoing server text', () => {
    expect(searchErrorMessage(new ApiError(0, 'network', 'x'))).toMatch(/reach the server/)
    expect(searchErrorMessage(new ApiError(400, 'invalid_input', 'query: secret detail'))).not.toMatch(/secret/)
    expect(searchErrorMessage(new ApiError(500, 'internal', 'x'))).toBe('Search failed. Try again.')
    expect(searchErrorMessage(new Error('x'))).toBe('Search failed. Try again.')
  })
})

import { describe, expect, it } from 'vitest'
import { documentIdFromPath, documentPath, pathFor, routeFromPath, ROUTES } from './router'

describe('router', () => {
  it.each([
    ['/', 'search'],
    ['/search', 'search'],
    ['/repos', 'repos'],
    ['/repos/pythia', 'repos'],
    ['/import', 'import'],
    ['/settings/', 'settings'],
    ['/nope', 'search'],
    ['', 'search'],
  ])('maps %s to %s', (path, route) => {
    expect(routeFromPath(path)).toBe(route)
  })

  it('round-trips every route through its path', () => {
    for (const route of ROUTES) expect(routeFromPath(pathFor(route))).toBe(route)
    expect(pathFor('search')).toBe('/')
  })

  it('reads the document id from /doc/<id> and keeps Search as the screen under it', () => {
    expect(documentIdFromPath(documentPath(42))).toBe(42)
    expect(documentIdFromPath('/doc/7/')).toBe(7)
    expect(routeFromPath('/doc/42')).toBe('search')
  })

  it.each(['/', '/doc', '/doc/', '/doc/0', '/doc/-1', '/doc/1.5', '/doc/abc', '/doc/12/extra', '/doc/12345678901234567'])(
    'finds no document id in %s',
    (path) => {
      expect(documentIdFromPath(path)).toBeNull()
    },
  )
})

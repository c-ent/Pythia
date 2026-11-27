import { describe, expect, it } from 'vitest'
import {
  documentIdFromPath,
  documentPath,
  pathFor,
  redirectFor,
  routeFromPath,
  ROUTES,
  SETTINGS_SECTIONS,
  settingsPath,
  settingsSectionFromPath,
} from './router'

describe('router', () => {
  it.each([
    ['/', 'search'],
    ['/search', 'search'],
    ['/ask', 'ask'],
    ['/repos', 'repos'],
    ['/repos/pythia', 'repos'],
    ['/pinned', 'pinned'],
    ['/sources', 'sources'],
    ['/settings/', 'settings'],
    ['/settings/gemini', 'settings'],
    ['/import', 'search'],
    ['/nope', 'search'],
    ['', 'search'],
  ])('maps %s to %s', (path, route) => {
    expect(routeFromPath(path)).toBe(route)
  })

  it('round-trips every route through its path', () => {
    for (const route of ROUTES) expect(routeFromPath(pathFor(route))).toBe(route)
    expect(pathFor('search')).toBe('/')
    expect(pathFor('settings')).toBe('/settings/profile')
  })

  it('reads the Settings section, defaulting to Profile', () => {
    for (const section of SETTINGS_SECTIONS) expect(settingsSectionFromPath(settingsPath(section))).toBe(section)
    expect(settingsSectionFromPath('/settings')).toBe('profile')
    expect(settingsSectionFromPath('/settings/nope')).toBe('profile')
    expect(settingsSectionFromPath('/repos/storage')).toBe('profile')
  })

  it.each([
    ['/import', '/sources'],
    ['/search', '/'],
    ['/settings', '/settings/profile'],
    ['/settings/', '/settings/profile'],
    ['/settings/nope', '/settings/profile'],
    ['/settings/storage', '/pinned'],
  ])('redirects the old or partial address %s to %s', (from, to) => {
    expect(redirectFor(from)).toBe(to)
  })

  it.each(['/', '/sources', '/ask', '/settings/gemini', '/doc/3', '/repos/pythia', '/import/extra'])(
    'leaves the current address %s alone',
    (path) => {
      expect(redirectFor(path)).toBeNull()
    },
  )

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

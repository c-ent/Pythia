import { describe, expect, it } from 'vitest'
import {
  documentIdFromPath,
  documentPath,
  navigate,
  pathFor,
  redirectFor,
  repoNameFromPath,
  repoPath,
  routeFromPath,
  ROUTES,
  SETTINGS_SECTIONS,
  settingsPath,
  settingsSectionFromPath,
  sourceBrowsePath,
  sourceKindFromPath,
} from './router'

describe('router', () => {
  it.each([
    ['/', 'search'],
    ['/search', 'search'],
    ['/ask', 'ask'],
    ['/repos', 'repos'],
    ['/repos/pythia', 'repos'],
    ['/pinned', 'pinned'],
    ['/map', 'map'],
    ['/sources', 'sources'],


    ['/settings/', 'settings'],
    ['/settings/gemini', 'settings'],
    ['/settings/server', 'settings'],
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

  it.each(['/', '/sources', '/ask', '/settings/gemini', '/settings/server', '/doc/3', '/repos/pythia', '/import/extra'])(
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

  it('parses and builds repo and source browse paths', () => {
    expect(repoNameFromPath('/repos/kitchen-app')).toBe('kitchen-app')
    expect(repoNameFromPath('/repos/a%20b')).toBe('a b')
    expect(repoNameFromPath('/repos')).toBeNull()
    expect(repoNameFromPath('/repos/a/b')).toBeNull()
    expect(repoPath('a b')).toBe('/repos/a%20b')
    expect(repoPath('a b', 'src/routes')).toBe('/repos/a%20b?folder=src%2Froutes')

    expect(sourceKindFromPath('/sources/obsidian')).toBe('obsidian')
    expect(sourceKindFromPath('/sources/keep')).toBe('keep')
    expect(sourceKindFromPath('/sources/gdrive')).toBe('gdrive')
    expect(sourceKindFromPath('/sources/github')).toBe('repo')
    expect(sourceKindFromPath('/sources')).toBeNull()
    expect(sourceKindFromPath('/sources/nope')).toBeNull()
    expect(sourceBrowsePath('obsidian', 'Projects')).toBe('/sources/obsidian?folder=Projects')
  })

  it('updates search query when navigating between the same pathname with different query strings', () => {
    window.history.replaceState(null, '', '/repos/pythia?folder=src')
    navigate('/repos/pythia')
    expect(window.location.pathname).toBe('/repos/pythia')
    expect(window.location.search).toBe('')
  })
})

import { useSyncExternalStore, type MouseEvent } from 'react'
import type { SourceKind } from './api/search'

export const ROUTES = ['search', 'ask', 'repos', 'pinned', 'map', 'sources', 'settings'] as const
export type RouteName = (typeof ROUTES)[number]

export const BROWSABLE_SOURCES = ['obsidian', 'repo', 'keep', 'gdrive'] as const

export const SETTINGS_SECTIONS = ['profile', 'gemini', 'devices', 'server'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

function isSettingsSection(value: string | undefined): value is SettingsSection {
  return value !== undefined && (SETTINGS_SECTIONS as readonly string[]).includes(value)
}

function segments(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '')
}

/** Unknown paths fall back to search, the home screen. */
export function routeFromPath(pathname: string): RouteName {
  const first = segments(pathname)[0] ?? ''
  return (ROUTES as readonly string[]).includes(first) ? (first as RouteName) : 'search'
}

/** The open Settings section; Profile when the path names none (or an unknown one). */
export function settingsSectionFromPath(pathname: string): SettingsSection {
  const [first, second] = segments(pathname)
  return first === 'settings' && isSettingsSection(second) ? second : 'profile'
}

export function settingsPath(section: SettingsSection): string {
  return `/settings/${section}`
}

export function pathFor(route: RouteName): string {
  if (route === 'search') return '/'
  if (route === 'settings') return settingsPath('profile')
  return `/${route}`
}

/**
 * Where an old or partial address lives now, or null when it is current:
 * `/import` became Sources, `/search` is Home, `/settings/storage` moved to
 * Pinned (T45), and `/settings` (or an unknown section) opens Profile.
 */
export function redirectFor(pathname: string): string | null {
  const parts = segments(pathname)
  if (parts.length === 1 && parts[0] === 'import') return pathFor('sources')
  if (parts.length === 1 && parts[0] === 'search') return pathFor('search')
  if (parts.length === 2 && parts[0] === 'settings' && parts[1] === 'storage') return pathFor('pinned')
  if (parts[0] === 'settings') {
    const target = settingsPath(settingsSectionFromPath(pathname))
    return target === pathname ? null : target
  }
  return null
}

// Same id rule as the server's `GET /api/documents/:id`.
const DOCUMENT_PATH = /^\/doc\/([1-9]\d{0,15})\/?$/

/**
 * The document id in `/doc/<id>`, or null for any other path. A document opens
 * over the Search screen (it is reached from search results and Ask sources),
 * so `routeFromPath` maps these paths to `search`.
 */
export function documentIdFromPath(pathname: string): number | null {
  const match = DOCUMENT_PATH.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export function documentPath(id: number): string {
  return `/doc/${id}`
}

function decodeSegment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim()
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
}

/** The repo name in `/repos/<name>`, or null for `/repos` or any other path. */
export function repoNameFromPath(pathname: string): string | null {
  const parts = segments(pathname)
  if (parts.length !== 2 || parts[0] !== 'repos' || parts[1] === undefined) return null
  return decodeSegment(parts[1])
}

export function repoPath(name: string, folder?: string): string {
  const base = `/repos/${encodeURIComponent(name)}`
  if (folder === undefined || folder === '') return base
  return `${base}?${new URLSearchParams({ folder }).toString()}`
}

/** The source kind in `/sources/<kind>`, or null for `/sources` or an unknown segment. */
export function sourceKindFromPath(pathname: string): SourceKind | null {
  const parts = segments(pathname)
  if (parts.length !== 2 || parts[0] !== 'sources' || parts[1] === undefined) return null
  if (parts[1] === 'github') return 'repo'
  return (BROWSABLE_SOURCES as readonly string[]).includes(parts[1]) ? (parts[1] as SourceKind) : null
}

export function sourceBrowsePath(kind: SourceKind, folder?: string): string {
  const base = `/sources/${kind}`
  if (folder === undefined || folder === '') return base
  return `${base}?${new URLSearchParams({ folder }).toString()}`
}

export const SOURCES_ACTIVITY_PATH = '/sources/activity'

export function isSourcesActivityPath(pathname: string): boolean {
  const parts = segments(pathname)
  return parts.length === 2 && parts[0] === 'sources' && parts[1] === 'activity'
}

export function sourcesActivityPath(): string {
  return SOURCES_ACTIVITY_PATH
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

/** Marks history entries this app pushed, so Back knows it stays inside the app. */
const IN_APP = { pythia: true }

export function navigate(path: string): void {
  if (`${window.location.pathname}${window.location.search}` === path) return
  window.history.pushState(IN_APP, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Swaps the address in place (no new history entry), for redirects. */
export function redirect(path: string): void {
  if (window.location.pathname === path) return
  window.history.replaceState(window.history.state, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Goes back when the previous entry is this app's; otherwise (a direct link, a new tab) opens `fallback`. */
export function goBack(fallback: string): void {
  const state: unknown = window.history.state
  if (state !== null && typeof state === 'object' && 'pythia' in state) window.history.back()
  else navigate(fallback)
}

/** Click handler for in-app `<a href>` links: plain clicks navigate in place, the rest go to the browser. */
export function followLink(event: MouseEvent<HTMLAnchorElement>, path: string): void {
  // Let the browser handle new-tab and new-window clicks.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(path)
}

/** The address bar path, kept in sync with navigation and back/forward. */
export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => '/',
  )
}

/** The address bar query string, kept in sync with navigation and back/forward. */
export function useLocationSearch(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => '',
  )
}

/** The current screen, kept in sync with the address bar and back/forward. */
export function useRoute(): RouteName {
  return routeFromPath(usePathname())
}

import { useSyncExternalStore, type MouseEvent } from 'react'

export const ROUTES = ['search', 'ask', 'repos', 'pinned', 'sources', 'settings'] as const
export type RouteName = (typeof ROUTES)[number]

export const SETTINGS_SECTIONS = ['profile', 'gemini', 'devices', 'storage'] as const
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
 * `/import` became Sources, `/search` is Home, and `/settings` (or an unknown
 * section) opens Profile.
 */
export function redirectFor(pathname: string): string | null {
  const parts = segments(pathname)
  if (parts.length === 1 && parts[0] === 'import') return pathFor('sources')
  if (parts.length === 1 && parts[0] === 'search') return pathFor('search')
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

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

/** Marks history entries this app pushed, so Back knows it stays inside the app. */
const IN_APP = { pythia: true }

export function navigate(path: string): void {
  if (window.location.pathname === path) return
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

/** The current screen, kept in sync with the address bar and back/forward. */
export function useRoute(): RouteName {
  return routeFromPath(usePathname())
}

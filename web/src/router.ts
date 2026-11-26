import { useSyncExternalStore, type MouseEvent } from 'react'

export const ROUTES = ['search', 'repos', 'import', 'settings'] as const
export type RouteName = (typeof ROUTES)[number]

/** Unknown paths fall back to search, the home screen. */
export function routeFromPath(pathname: string): RouteName {
  const first = pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  return (ROUTES as readonly string[]).includes(first) ? (first as RouteName) : 'search'
}

export function pathFor(route: RouteName): string {
  return route === 'search' ? '/' : `/${route}`
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

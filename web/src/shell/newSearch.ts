import { useEffect, useLayoutEffect, useRef } from 'react'
import { navigate, pathFor } from '../router'

// "New search" (the sidebar button, Ctrl K / ⌘ K) opens Search and clears it.
// Search may not be mounted yet when asked (another screen is open), so the
// request waits here until it mounts.
const EVENT = 'pythia:new-search'
let waiting = false

export function startNewSearch(): void {
  waiting = true
  navigate(pathFor('search'))
  window.dispatchEvent(new Event(EVENT))
}

/** Runs `onStart` for each new-search request, including one made just before mounting. */
export function useNewSearch(onStart: () => void): void {
  const latest = useRef(onStart)
  useLayoutEffect(() => {
    latest.current = onStart
  })
  useEffect(() => {
    const start = (): void => {
      waiting = false
      latest.current()
    }
    if (waiting) start()
    window.addEventListener(EVENT, start)
    return () => window.removeEventListener(EVENT, start)
  }, [])
}

export function isNewSearchShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k'
}

/** "⌘ K" on Apple devices, "Ctrl K" elsewhere. */
export function shortcutLabel(): string {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K'
}

import { useCallback, useSyncExternalStore } from 'react'

function matcher(query: string): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
}

/** Whether the CSS media query matches, kept in sync; false where `matchMedia` is missing (tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matcher(query)
      list?.addEventListener('change', onChange)
      return () => list?.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => matcher(query)?.matches ?? false,
    () => false,
  )
}

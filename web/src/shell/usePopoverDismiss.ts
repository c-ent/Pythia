import { useEffect, type RefObject } from 'react'

/** Closes a popover on outside pointerdown or Escape. */
export function usePopoverDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  close: (restoreFocus: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        close(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(true)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, containerRef, close])
}

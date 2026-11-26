import { useEffect, useRef, type HTMLAttributes } from 'react'

/**
 * A single row that scrolls sideways when it does not fit. The scrollbar is
 * hidden; instead the edge that has more content fades out (`.scroll-row` in
 * index.css), and a vertical mouse wheel scrolls the row until it reaches the end.
 */
export function ScrollRow({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const row = ref.current
    if (row === null) return

    const update = (): void => {
      const max = row.scrollWidth - row.clientWidth
      row.toggleAttribute('data-more-start', row.scrollLeft > 1)
      row.toggleAttribute('data-more-end', max - row.scrollLeft > 1)
    }

    // Mouse users have no horizontal wheel: turn vertical scrolling into
    // sideways scrolling, but hand it back to the page at either end.
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      const max = row.scrollWidth - row.clientWidth
      if (max <= 0) return
      const next = Math.min(max, Math.max(0, row.scrollLeft + event.deltaY))
      if (Math.abs(next - row.scrollLeft) < 1) return
      event.preventDefault()
      row.scrollLeft = next
    }

    // Start with the current item (a Settings tab) in view, not cut off at the edge.
    const current = row.querySelector<HTMLElement>('[aria-current="page"]')
    if (current !== null) {
      const start = current.offsetLeft - row.offsetLeft
      const end = start + current.offsetWidth
      if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth + 32
    }

    update()
    row.addEventListener('scroll', update, { passive: true })
    row.addEventListener('wheel', onWheel, { passive: false })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    if (observer !== null) {
      observer.observe(row)
      for (const child of Array.from(row.children)) observer.observe(child)
    }
    return () => {
      row.removeEventListener('scroll', update)
      row.removeEventListener('wheel', onWheel)
      observer?.disconnect()
    }
  }, [])

  return (
    <div ref={ref} className={`scroll-row ${className}`} {...rest}>
      {children}
    </div>
  )
}

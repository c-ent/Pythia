import type { Snippet } from '../api/search'
import { splitHighlights } from './highlight'

/** Snippet text with matches in `<mark>`; built from offsets, never from HTML. */
export function Highlighted({ snippet }: { snippet: Snippet }) {
  return (
    <>
      {splitHighlights(snippet).map((segment, i) =>
        segment.marked ? (
          <mark key={i} className="rounded-sm bg-mark text-ink">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  )
}

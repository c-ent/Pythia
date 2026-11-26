import type { Snippet } from '../api/search'

export interface Segment {
  text: string
  marked: boolean
}

/**
 * Splits a snippet into plain and highlighted runs. Offsets are clamped to the
 * text, sorted, and overlaps merged, so a bad range from the server can never
 * drop or repeat text.
 */
export function splitHighlights(snippet: Snippet): Segment[] {
  const { text } = snippet
  const clamp = (n: number): number => Math.max(0, Math.min(Number.isFinite(n) ? n : 0, text.length))
  const ranges = snippet.highlights
    .map(([start, end]): [number, number] => [clamp(start), clamp(end)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])

  const segments: Segment[] = []
  let at = 0
  for (const [rangeStart, end] of ranges) {
    const start = Math.max(rangeStart, at)
    if (end <= start) continue
    if (start > at) segments.push({ text: text.slice(at, start), marked: false })
    segments.push({ text: text.slice(start, end), marked: true })
    at = end
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false })
  return segments
}

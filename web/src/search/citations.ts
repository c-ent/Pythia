import type { AskResponse } from '../api/ask'

export type AnswerSegment = { kind: 'text'; text: string } | { kind: 'cite'; n: number }

// `[2]` or `[1, 3]`. Two digits is plenty: the server cites at most 10 passages.
const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g

/**
 * Splits a model answer into plain text and `[n]` citation markers. A marker
 * becomes a citation only when every number in it is a passage the server
 * returned; anything else (a made-up `[7]`, a markdown link) stays as text.
 */
export function splitCitations(text: string, known: ReadonlySet<number>): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  const pushText = (value: string): void => {
    if (value === '') return
    const last = segments.at(-1)
    if (last?.kind === 'text') last.text += value
    else segments.push({ kind: 'text', text: value })
  }

  let at = 0
  for (const match of text.matchAll(CITATION)) {
    const numbers = (match[1] ?? '').split(',').map((part) => Number(part.trim()))
    if (!numbers.every((n) => known.has(n))) continue
    pushText(text.slice(at, match.index))
    for (const n of numbers) segments.push({ kind: 'cite', n })
    at = match.index + match[0].length
  }
  pushText(text.slice(at))
  return segments
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** One sentence on why this engine answered, or null when nothing needs saying. */
export function engineNote(response: Pick<AskResponse, 'engine' | 'fallbacks' | 'withheld'>): string | null {
  const { engine, fallbacks, withheld } = response
  const had = (reason: AskResponse['fallbacks'][number]): boolean => fallbacks.includes(reason)

  if (engine === 'gemini') {
    return withheld > 0
      ? `${plural(withheld, 'local-only match was', 'local-only matches were')} kept from Gemini.`
      : null
  }

  if (engine === 'ollama') {
    if (had('all_private')) return 'Every match is local only, so the local model answered instead of Gemini.'
    if (had('gemini_failed')) return 'Gemini didn’t answer, so the local model did.'
    if (had('gemini_unconfigured')) return 'Gemini isn’t set up, so the local model answered.'
    return null
  }

  if (had('gemini_failed') || had('ollama_failed')) {
    return 'The AI models couldn’t answer right now, so these are the passages that match best.'
  }
  if (had('all_private') && had('ollama_unconfigured')) {
    return 'Every match is local only and the local model isn’t set up, so these are the passages that match best.'
  }
  return 'No AI model is set up, so these are the passages that match best.'
}

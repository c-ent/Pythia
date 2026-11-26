import type { AskEngine, AskResponse } from '../api/ask'
import type { SourceKind } from '../api/search'
import type { AnswerState } from '../search/AskAnswer'

// Ask page (T33) helpers, kept apart from AskScreen.tsx so that file exports only components.

export interface AskTurn {
  question: string
  sources: SourceKind[]
  state: AnswerState
}

/**
 * The last question and source filter, kept in memory while the app is open:
 * a source link opens the document in place of the Ask page, and Back should
 * come back to the same answer. A question still loading is asked again.
 */
export const askMemory: { turn: AskTurn | null; sources: SourceKind[] } = { turn: null, sources: [] }

export function resetAskMemory(): void {
  askMemory.turn = null
  askMemory.sources = []
}

/** The Gemini → local model → snippets chain, in order, for the Answer engine panel. */
export const ENGINE_STEPS: readonly { engine: AskEngine; label: string; when: string }[] = [
  { engine: 'gemini', label: 'Gemini', when: 'First choice' },
  { engine: 'ollama', label: 'Local model', when: 'If Gemini fails' },
  { engine: 'retrieval', label: 'Snippets only', when: 'Always works' },
]

export function engineLabel(engine: AskEngine): string {
  return ENGINE_STEPS.find((step) => step.engine === engine)?.label ?? engine
}

export function sourceCount(n: number): string {
  return n === 1 ? 'Used 1 source' : `Used ${n} sources`
}

/** The answer as plain text for the clipboard: the `[n]` markers stay, with the numbered sources after it. */
export function answerForCopy(response: Pick<AskResponse, 'answer' | 'citations'>): string {
  const lines = [(response.answer ?? '').trim()]
  if (response.citations.length > 0) {
    lines.push('', 'Sources')
    for (const citation of response.citations) lines.push(`[${citation.n}] ${citation.title} (${citation.path})`)
  }
  return lines.join('\n').trim()
}

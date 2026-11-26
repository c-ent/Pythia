import type { AskEngine } from '../api/ask'

export type Engine = AskEngine

const LABELS: Record<Engine, string> = { gemini: 'Gemini', ollama: 'Local model', retrieval: 'Retrieval only' }

/** Which engine produced an Ask answer (ui.md: gemini / ollama / retrieval). */
export function EngineBadge({ engine, model = null }: { engine: Engine; model?: string | null }) {
  return (
    <span
      title={model ?? undefined}
      className="inline-flex items-center rounded-full border border-line bg-raised px-2.5 py-0.5 text-xs text-muted"
    >
      <span className="sr-only">Answered by: </span>
      {LABELS[engine]}
      {model === null ? null : <span className="sr-only"> ({model})</span>}
    </span>
  )
}

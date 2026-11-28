import { ApiError, apiFetch } from './client'
import { recentQueriesChanged } from './recent'
import type { Snippet, SourceKind, SourceRef } from './search'

// Mirrors the server's Ask types (server/src/ask/askService.ts).

export type AskEngine = 'gemini' | 'ollama' | 'retrieval'

/** Why an earlier step of the Gemini → local model → retrieval chain did not answer, in chain order. */
export type FallbackReason =
  | 'no_results'
  | 'gemini_unconfigured'
  | 'all_private'
  | 'gemini_failed'
  | 'ollama_unconfigured'
  | 'ollama_failed'

export interface AskCitation {
  /** The `[n]` the answer uses for this passage. */
  n: number
  chunkId: number
  documentId: number
  source: SourceRef
  path: string
  title: string
  headingPath: string
  startLine: number | null
  endLine: number | null
  allowLlm: boolean
  snippet: Snippet
}

export interface AskResponse {
  /** Null when no model answered (engine `retrieval`). */
  answer: string | null
  engine: AskEngine
  /** Model that answered, or null for `retrieval`. */
  model: string | null
  fallbacks: FallbackReason[]
  citations: AskCitation[]
  /** Matching passages kept from Gemini because their document has `allow_llm = false`. */
  withheld: number
  /** True when only full-text search ran (embeddings unavailable). */
  degraded: boolean
}

export interface AskHistoryTurn {
  question: string
  answer: string
}

export interface AskParams {
  question: string
  history?: AskHistoryTurn[]
  sources?: SourceKind[]
  repo?: string
  limit?: number
}

async function readAskStream(
  body: ReadableStream<Uint8Array>,
  onUpdate?: (partial: AskResponse) => void,
): Promise<AskResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let current: AskResponse | null = null
  let eventName = ''
  let dataLines: string[] = []

  const flushEvent = (): AskResponse | null => {
    if (dataLines.length === 0) {
      eventName = ''
      return null
    }
    const raw = dataLines.join('\n')
    const kind = eventName
    eventName = ''
    dataLines = []
    const payload = JSON.parse(raw) as Record<string, unknown>
    if (kind === 'meta') {
      current = {
        answer: '',
        engine: payload.engine as AskEngine,
        model: (payload.model as string | null) ?? null,
        fallbacks: (payload.fallbacks as FallbackReason[]) ?? [],
        citations: (payload.citations as AskCitation[]) ?? [],
        withheld: Number(payload.withheld ?? 0),
        degraded: Boolean(payload.degraded),
      }
      onUpdate?.(current)
    } else if (kind === 'token' && current !== null) {
      current = { ...current, answer: `${current.answer ?? ''}${String(payload.text ?? '')}` }
      onUpdate?.(current)
    } else if (kind === 'done' && current !== null) {
      current = { ...current, answer: (payload.answer as string | null) ?? null }
      return current
    } else if (kind === 'error') {
      throw new ApiError(500, 'ask_failed', typeof payload.message === 'string' ? payload.message : 'Ask failed')
    }
    return null
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          const finished = flushEvent()
          if (finished !== null) return finished
          continue
        }
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
    }
    const finished = flushEvent()
    if (finished !== null) return finished
  } finally {
    reader.releaseLock()
  }
  if (current !== null) return current
  throw new ApiError(500, 'ask_failed', 'Ask stream ended unexpectedly')
}

export async function askQuestion(
  params: AskParams,
  signal?: AbortSignal,
  onUpdate?: (partial: AskResponse) => void,
): Promise<AskResponse> {
  const res = await apiFetch('/api/ask', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify(params),
    signal,
  })
  const contentType = res.headers.get('content-type') ?? ''
  const response =
    contentType.includes('text/event-stream') && res.body !== null
      ? await readAskStream(res.body, onUpdate)
      : ((await res.json()) as AskResponse)
  // The server recorded the question before answering (R14).
  recentQueriesChanged('ask')
  return response
}

import { combineSignals, LlmError, type ChatModel, type ChatPrompt, type FetchFn } from './llm.js'

/**
 * Local answer model through Ollama's `/api/chat` (R8 fallback step 2).
 * Runs on the same host as the embedder, so private notes stay on the box.
 */

/**
 * Picked 2026-11-25 for the Oracle Arm host (4 OCPU / 24 GB, CPU only):
 * about 2.5 GB, the strongest all-round instruct model in the 3–4B range on
 * CPU. Override with `OLLAMA_CHAT_MODEL`.
 */
export const DEFAULT_OLLAMA_CHAT_MODEL = 'qwen3:4b'

/** CPU generation is slow: prompt processing plus a few hundred tokens. */
const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_TOKENS = 768
const MAX_ERROR_DETAIL = 200

export interface OllamaChatOptions {
  baseUrl: string
  model?: string
  timeoutMs?: number
  fetch?: FetchFn
}

/** Thinking models can put their reasoning inline; only the answer is kept. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim()
}

function createThinkFilter(onToken: (delta: string) => void) {
  let state: 'leading' | 'in_think' | 'streaming' = 'leading'
  let buffer = ''

  const push = (chunk: string): void => {
    if (chunk === '') return
    if (state === 'streaming') {
      onToken(chunk)
      return
    }
    buffer += chunk
    while (buffer !== '') {
      if (state === 'in_think') {
        const end = buffer.indexOf('</think>')
        if (end === -1) {
          // Keep tail in case `</think>` spans two chunks.
          if (buffer.length > 8) buffer = buffer.slice(-8)
          return
        }
        buffer = buffer.slice(end + 8).replace(/^\s+/, '')
        state = 'leading'
        continue
      }
      const trimmedStart = buffer.replace(/^\s+/, '')
      if (trimmedStart === '') return
      if (trimmedStart.startsWith('<think>')) {
        buffer = trimmedStart.slice(7)
        state = 'in_think'
        continue
      }
      if ('<think>'.startsWith(trimmedStart)) return
      state = 'streaming'
      onToken(trimmedStart)
      buffer = ''
    }
  }

  const flush = (): void => {
    if (state === 'leading') {
      const trimmed = buffer.trim()
      if (trimmed !== '') onToken(trimmed)
      buffer = ''
    }
  }

  return { push, flush }
}

function buildMessages({ system, user, history }: ChatPrompt) {
  return [
    { role: 'system', content: system },
    ...(history ?? []).flatMap((turn) => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]),
    { role: 'user', content: user },
  ]
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return `: ${body.error.slice(0, MAX_ERROR_DETAIL)}`
    }
  } catch {
    // Not JSON; the status alone has to do.
  }
  return ''
}

export function createOllamaChatModel(options: OllamaChatOptions): ChatModel {
  const model = options.model ?? DEFAULT_OLLAMA_CHAT_MODEL
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/chat`

  async function openResponse(prompt: ChatPrompt, stream: boolean, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: buildMessages(prompt),
          stream,
          options: { temperature: 0.2, num_predict: MAX_OUTPUT_TOKENS },
        }),
        signal: combineSignals(timeoutMs, signal),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const reason = error instanceof Error && error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'network error'
      throw new LlmError(`Ollama chat request failed: ${reason}`, { cause: error })
    }

    // Ollama's own error (e.g. "model not found") never quotes the prompt.
    if (!response.ok) {
      throw new LlmError(`Ollama chat returned HTTP ${response.status}${await errorDetail(response)}`, {
        status: response.status,
      })
    }
    return response
  }

  return {
    engine: 'ollama',
    model,
    async generate(prompt) {
      const response = await openResponse(prompt, false)
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        throw new LlmError('Ollama chat returned a body that is not JSON', { cause: error })
      }
      const message = body !== null && typeof body === 'object' && 'message' in body ? body.message : undefined
      const content =
        message !== null && typeof message === 'object' && 'content' in message && typeof message.content === 'string'
          ? stripThinking(message.content)
          : ''
      if (content === '') throw new LlmError('Ollama chat returned no answer text')
      return content
    },
    async generateStream(prompt, onToken, signal) {
      const response = await openResponse(prompt, true, signal)
      if (response.body === null) throw new LlmError('Ollama chat returned an empty stream')

      let full = ''
      const filter = createThinkFilter((delta) => {
        full += delta
        onToken(delta)
      })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed === '') continue
            let chunk: unknown
            try {
              chunk = JSON.parse(trimmed)
            } catch {
              continue
            }
            if (chunk !== null && typeof chunk === 'object' && 'error' in chunk && typeof chunk.error === 'string') {
              throw new LlmError(`Ollama chat error: ${chunk.error.slice(0, MAX_ERROR_DETAIL)}`)
            }
            const msg = chunk !== null && typeof chunk === 'object' && 'message' in chunk ? chunk.message : undefined
            const delta = msg !== null && typeof msg === 'object' && 'content' in msg && typeof msg.content === 'string' ? msg.content : ''
            filter.push(delta)
          }
        }
      } finally {
        reader.releaseLock()
      }
      filter.flush()
      const trimmed = full.trim()
      if (trimmed === '') throw new LlmError('Ollama chat returned no answer text')
      return trimmed
    },
  }
}

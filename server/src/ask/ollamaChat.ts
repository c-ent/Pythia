import { LlmError, type ChatModel, type FetchFn } from './llm.js'

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

  return {
    engine: 'ollama',
    model,
    async generate({ system, user }) {
      let response: Response
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            stream: false,
            options: { temperature: 0.2, num_predict: MAX_OUTPUT_TOKENS },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        const reason = error instanceof Error && error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'network error'
        throw new LlmError(`Ollama chat request failed: ${reason}`, { cause: error })
      }

      // Ollama's own error (e.g. "model not found") never quotes the prompt.
      if (!response.ok) {
        throw new LlmError(`Ollama chat returned HTTP ${response.status}${await errorDetail(response)}`, {
          status: response.status,
        })
      }

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
  }
}

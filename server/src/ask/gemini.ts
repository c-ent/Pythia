import { combineSignals, defaultSleep, LlmError, parseRetryAfter, type ChatModel, type ChatPrompt, type FetchFn } from './llm.js'

/**
 * Gemini API client (`models.generateContent`, REST). Server-side only: the
 * key is sent in the `x-goog-api-key` header, never in the URL, so it cannot
 * end up in proxy or access logs.
 */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
/** Stable Flash-Lite model as of 2026-11; override with `GEMINI_MODEL`. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'

const DEFAULT_TIMEOUT_MS = 30_000
/** Extra attempts after a 429 or 5xx. */
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1_000
/** A `Retry-After` longer than this is not worth waiting for; fall back instead. */
const MAX_RETRY_WAIT_MS = 20_000
const MAX_OUTPUT_TOKENS = 1024

export interface GeminiOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  retries?: number
  /** First backoff delay; doubles after each failed attempt. */
  retryDelayMs?: number
  fetch?: FetchFn
  sleep?: (ms: number) => Promise<void>
}

interface GeminiPart {
  text?: unknown
  thought?: unknown
}

function extractPartsText(body: unknown): { text: string; finishReason: string } {
  if (body === null || typeof body !== 'object') throw new LlmError('Gemini returned a body that is not an object')
  const feedback = 'promptFeedback' in body ? body.promptFeedback : undefined
  if (feedback !== null && typeof feedback === 'object' && 'blockReason' in feedback) {
    throw new LlmError(`Gemini blocked the prompt (${String(feedback.blockReason)})`)
  }
  const candidates = 'candidates' in body ? body.candidates : undefined
  const first: unknown = Array.isArray(candidates) ? candidates[0] : undefined
  if (first === null || typeof first !== 'object') throw new LlmError('Gemini returned no candidates')
  const content = 'content' in first ? first.content : undefined
  const parts = content !== null && typeof content === 'object' && 'parts' in content ? content.parts : undefined
  const text = Array.isArray(parts)
    ? (parts as GeminiPart[])
        .filter((part) => part.thought !== true && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('')
    : ''
  const finishReason = 'finishReason' in first ? String(first.finishReason) : 'unknown'
  return { text, finishReason }
}

function extractText(body: unknown): string {
  const { text, finishReason } = extractPartsText(body)
  const trimmed = text.trim()
  if (trimmed === '') {
    throw new LlmError(`Gemini returned no answer text (finishReason ${finishReason})`)
  }
  return trimmed
}

function buildRequestBody({ system, user, history }: ChatPrompt): string {
  const contents = [
    ...(history ?? []).flatMap((turn) => [
      { role: 'user', parts: [{ text: turn.question }] },
      { role: 'model', parts: [{ text: turn.answer }] },
    ]),
    { role: 'user', parts: [{ text: user }] },
  ]
  return JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS },
  })
}

export function createGeminiModel(options: GeminiOptions): ChatModel {
  const model = options.model ?? DEFAULT_GEMINI_MODEL
  const baseUrl = (options.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? defaultSleep
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`
  const streamUrl = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

  if (options.apiKey.trim() === '') throw new RangeError('apiKey must not be empty')
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer')

  async function openResponse(targetUrl: string, prompt: ChatPrompt, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetchFn(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: buildRequestBody(prompt),
        signal: combineSignals(timeoutMs, signal),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const reason = error instanceof Error && error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'network error'
      // Timeouts are not retried: the caller has a fallback and the user is waiting.
      throw new LlmError(`Gemini request failed: ${reason}`, { cause: error })
    }

    if (!response.ok) {
      // The error body can echo request details, so only the status is kept.
      await response.body?.cancel().catch(() => {})
      throw new LlmError(`Gemini returned HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      })
    }
    return response
  }

  async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (error) {
        if (signal?.aborted === true) throw error
        if (!(error instanceof LlmError) || !error.retryable || attempt >= retries) throw error
        const backoff = retryDelayMs * 2 ** attempt
        const wait = Math.max(backoff, error.retryAfterMs ?? 0)
        if (wait > MAX_RETRY_WAIT_MS) throw error
        await sleep(wait)
      }
    }
  }

  return {
    engine: 'gemini',
    model,
    async generate(prompt) {
      return withRetry(async () => {
        const response = await openResponse(url, prompt)
        let body: unknown
        try {
          body = await response.json()
        } catch (error) {
          throw new LlmError('Gemini returned a body that is not JSON', { cause: error })
        }
        return extractText(body)
      })
    },
    async generateStream(prompt, onToken, signal) {
      const response = await withRetry(() => openResponse(streamUrl, prompt, signal), signal)
      if (response.body === null) {
        let body: unknown
        try {
          body = await response.json()
        } catch (error) {
          throw new LlmError('Gemini returned a body that is not JSON', { cause: error })
        }
        const text = extractText(body)
        onToken(text)
        return text
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '' || payload === '[DONE]') continue
            let chunk: unknown
            try {
              chunk = JSON.parse(payload)
            } catch {
              continue
            }
            const { text } = extractPartsText(chunk)
            if (text === '') continue
            full += text
            onToken(text)
          }
        }
      } finally {
        reader.releaseLock()
      }
      const trimmed = full.trim()
      if (trimmed === '') throw new LlmError('Gemini returned no answer text')
      return trimmed
    },
  }
}

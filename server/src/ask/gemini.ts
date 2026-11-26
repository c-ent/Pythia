import { defaultSleep, LlmError, parseRetryAfter, type ChatModel, type FetchFn } from './llm.js'

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

function extractText(body: unknown): string {
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
        .trim()
    : ''
  if (text === '') {
    const reason = 'finishReason' in first ? String(first.finishReason) : 'unknown'
    throw new LlmError(`Gemini returned no answer text (finishReason ${reason})`)
  }
  return text
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

  if (options.apiKey.trim() === '') throw new RangeError('apiKey must not be empty')
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer')

  async function requestOnce(system: string, user: string): Promise<string> {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
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

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new LlmError('Gemini returned a body that is not JSON', { cause: error })
    }
    return extractText(body)
  }

  return {
    engine: 'gemini',
    model,
    async generate({ system, user }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await requestOnce(system, user)
        } catch (error) {
          if (!(error instanceof LlmError) || !error.retryable || attempt >= retries) throw error
          const backoff = retryDelayMs * 2 ** attempt
          const wait = Math.max(backoff, error.retryAfterMs ?? 0)
          if (wait > MAX_RETRY_WAIT_MS) throw error
          await sleep(wait)
        }
      }
    },
  }
}

/** Shared types for the answer models behind `POST /api/ask` (R8). */

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface ChatPrompt {
  system: string
  user: string
}

export interface ChatModel {
  readonly engine: 'gemini' | 'ollama'
  readonly model: string
  /** Returns the answer text. Throws `LlmError` on any failure. */
  generate(prompt: ChatPrompt): Promise<string>
}

/**
 * Messages carry the engine, status and failure kind only. They never quote
 * the prompt, the answer or the API key: prompts hold private note text.
 */
export class LlmError extends Error {
  override name = 'LlmError'
  readonly status: number | undefined
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    details: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause })
    this.status = details.status
    this.retryable = details.retryable ?? false
    this.retryAfterMs = details.retryAfterMs
  }
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** `Retry-After` in seconds or as an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  const status = 'status' in error && typeof error.status === 'number' ? ` ${error.status}` : ''
  return `${error.name}${status}`
}

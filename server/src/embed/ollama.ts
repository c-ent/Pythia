/**
 * Embedding client for Ollama's `/api/embed` endpoint.
 *
 * `nomic-embed-text` is trained with task prefixes: stored text must start
 * with `search_document: ` and queries with `search_query: `. Leaving them out
 * still returns vectors, just worse ones, so callers never add prefixes
 * themselves; `embedDocuments` and `embedQuery` do it.
 */

import { UNGATED, type EmbedGate, type EmbedPriority } from './embedGate.js'

export const EMBED_MODEL = 'nomic-embed-text'
export const EMBED_DIMENSIONS = 768
export const DOCUMENT_PREFIX = 'search_document: '
export const QUERY_PREFIX = 'search_query: '
/** Within the 16–32 range from the architecture doc; the last batch may be smaller. */
export const DEFAULT_BATCH_SIZE = 32

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 500
const MAX_ERROR_DETAIL = 200

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface OllamaEmbedderOptions {
  /** e.g. `http://127.0.0.1:11434`; a path prefix behind a proxy is kept. */
  baseUrl: string
  model?: string
  /** Every returned vector must have this length; it matches `vector(768)` in the schema. */
  dimensions?: number
  batchSize?: number
  /** Per request. CPU-only hosts are slow, so the default is generous. */
  timeoutMs?: number
  /** Extra attempts after a network error, timeout, 429 or 5xx. 4xx errors are not retried. */
  retries?: number
  /** Doubles after each failed attempt. */
  retryDelayMs?: number
  fetch?: FetchFn
  sleep?: (ms: number) => Promise<void>
  /**
   * Shared with the other embedders of the process so queries go ahead of
   * index batches (T51). Defaults to no gate.
   */
  gate?: EmbedGate
  /**
   * `query`: the timeout also counts the wait at the gate, so a search still
   * gives up on time. `index` (default): the timeout starts when the request is sent.
   */
  priority?: EmbedPriority
  /**
   * Texts per request to Ollama, at most `batchSize`. A search waits behind
   * one request at most, so with a gate keep this small on CPU-only hosts.
   * Defaults to `batchSize`.
   */
  turnSize?: number
}

export interface Embedder {
  readonly model: string
  readonly dimensions: number
  /** Embeds chunk text for storage, in input order. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

/**
 * Messages carry the status and Ollama's own error, never the input text,
 * which may come from a private note.
 */
export class OllamaError extends Error {
  override name = 'OllamaError'
  readonly status: number | undefined
  readonly retryable: boolean

  constructor(message: string, details: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: details.cause })
    this.status = details.status
    this.retryable = details.retryable ?? false
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

function isVector(value: unknown, dimensions: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
}

export function createOllamaEmbedder(options: OllamaEmbedderOptions): Embedder {
  const model = options.model ?? EMBED_MODEL
  const dimensions = options.dimensions ?? EMBED_DIMENSIONS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  const sleep = options.sleep ?? defaultSleep
  const gate = options.gate ?? UNGATED
  const priority = options.priority ?? 'index'
  const turnSize = Math.min(options.turnSize ?? batchSize, batchSize)
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/embed`

  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer')
  if (!Number.isInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer')
  if (!Number.isInteger(turnSize) || turnSize < 1) throw new RangeError('turnSize must be a positive integer')

  async function requestOnce(input: string[]): Promise<number[][]> {
    if (priority === 'index') return gate.run('index', () => send(input, AbortSignal.timeout(timeoutMs)))
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      return await gate.run('query', () => send(input, signal), signal)
    } catch (error) {
      // Timed out while still waiting at the gate: never sent.
      if (!(error instanceof OllamaError) && error instanceof Error && error.name === 'TimeoutError') {
        throw new OllamaError(`Ollama embed request failed: timed out after ${timeoutMs} ms`, {
          retryable: true,
          cause: error,
        })
      }
      throw error
    }
  }

  async function send(input: string[], signal: AbortSignal): Promise<number[][]> {
    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Ollama runs nomic-embed-text with a 2048-token context. Chunks are
        // sized well under that; `truncate` keeps an outlier from failing the
        // whole batch.
        body: JSON.stringify({ model, input, truncate: true }),
        signal,
      })
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `timed out after ${timeoutMs} ms`
          : error instanceof Error
            ? error.message
            : String(error)
      throw new OllamaError(`Ollama embed request failed: ${reason}`, { retryable: true, cause: error })
    }

    if (!response.ok) {
      throw new OllamaError(`Ollama embed returned HTTP ${response.status}${await errorDetail(response)}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      })
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      throw new OllamaError('Ollama embed returned a body that is not JSON', { cause: error })
    }
    const embeddings = body !== null && typeof body === 'object' && 'embeddings' in body ? body.embeddings : undefined
    if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
      throw new OllamaError(
        `Ollama embed returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} embeddings for ${input.length} inputs`,
      )
    }
    if (!embeddings.every((vector) => isVector(vector, dimensions))) {
      throw new OllamaError(`Ollama embed returned a vector that is not ${dimensions} finite numbers (model ${model})`)
    }
    return embeddings as number[][]
  }

  async function request(input: string[]): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(input)
      } catch (error) {
        if (!(error instanceof OllamaError) || !error.retryable || attempt >= retries) throw error
        await sleep(retryDelayMs * 2 ** attempt)
      }
    }
  }

  return {
    model,
    dimensions,
    async embedDocuments(texts) {
      const vectors: number[][] = []
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize).map((text) => DOCUMENT_PREFIX + text)
        for (let turn = 0; turn < batch.length; turn += turnSize) {
          vectors.push(...(await request(batch.slice(turn, turn + turnSize))))
        }
      }
      return vectors
    },
    async embedQuery(text) {
      const [vector] = await request([QUERY_PREFIX + text])
      // request() already checked there is exactly one vector.
      return vector as number[]
    },
  }
}

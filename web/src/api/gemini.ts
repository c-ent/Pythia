import { ApiError, apiFetch } from './client'

// Mirrors `/api/settings/gemini` (server/src/routes/geminiSettings.ts), R16.

export type GeminiKeySource = 'env' | 'settings'

/**
 * - `secrets_key_missing`: a key is saved but `PYTHIA_SECRETS_KEY` is not set.
 * - `undecryptable`: a key is saved but `PYTHIA_SECRETS_KEY` cannot open it; it is treated as no key.
 */
export type GeminiKeyWarning = 'secrets_key_missing' | 'undecryptable'

/** Never the key itself: whether one is in use, where it comes from and its last 4 characters. */
export interface GeminiStatus {
  configured: boolean
  source: GeminiKeySource | null
  last4: string | null
  /** ISO date the saved key was saved; null without a saved key. */
  savedAt: string | null
  /** A key is saved while `GEMINI_API_KEY` in `.env` wins over it. */
  envOverridesSaved: boolean
  /** `PYTHIA_SECRETS_KEY` is set, so a key can be saved. */
  canSave: boolean
  warning: GeminiKeyWarning | null
  model: string
  /** Gemini requests today (Asia/Taipei date). */
  usedToday: number
}

export type GeminiTestError = 'no_key' | 'invalid_key' | 'rate_limited' | 'unreachable' | 'failed'
export type GeminiTestResult = { ok: true } | { ok: false; error: GeminiTestError }

const TEST_ERRORS: readonly string[] = ['no_key', 'invalid_key', 'rate_limited', 'unreachable', 'failed']

const badResponse = (): ApiError => new ApiError(500, 'bad_response', 'Unexpected response')

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json()
    if (body !== null && typeof body === 'object') return body as Record<string, unknown>
  } catch {
    // Not JSON; refused below.
  }
  throw badResponse()
}

function parseStatus(body: Record<string, unknown>): GeminiStatus {
  if (typeof body.configured !== 'boolean' || typeof body.canSave !== 'boolean' || typeof body.usedToday !== 'number') {
    throw badResponse()
  }
  return {
    configured: body.configured,
    source: body.source === 'env' || body.source === 'settings' ? body.source : null,
    last4: typeof body.last4 === 'string' ? body.last4 : null,
    savedAt: typeof body.savedAt === 'string' ? body.savedAt : null,
    envOverridesSaved: body.envOverridesSaved === true,
    canSave: body.canSave,
    warning: body.warning === 'secrets_key_missing' || body.warning === 'undecryptable' ? body.warning : null,
    model: typeof body.model === 'string' ? body.model : '',
    usedToday: body.usedToday,
  }
}

export async function getGeminiStatus(signal?: AbortSignal): Promise<GeminiStatus> {
  return parseStatus(await readJson(await apiFetch('/api/settings/gemini', { signal })))
}

/** Encrypts and saves the key on the server. Refused with 409 `secrets_key_missing` without `PYTHIA_SECRETS_KEY`. */
export async function saveGeminiKey(apiKey: string): Promise<GeminiStatus> {
  const res = await apiFetch('/api/settings/gemini/key', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  })
  return parseStatus(await readJson(res))
}

/** Removes the saved key; a key in `.env` is untouched. */
export async function removeGeminiKey(): Promise<GeminiStatus> {
  return parseStatus(await readJson(await apiFetch('/api/settings/gemini/key', { method: 'DELETE' })))
}

/** One minimal Gemini call with the key in use. */
export async function testGeminiKey(): Promise<GeminiTestResult> {
  const body = await readJson(await apiFetch('/api/settings/gemini/test', { method: 'POST' }))
  if (body.ok === true) return { ok: true }
  const error = typeof body.error === 'string' && TEST_ERRORS.includes(body.error) ? (body.error as GeminiTestError) : 'failed'
  return { ok: false, error }
}

/** Window event fired after the key was saved or removed, so the top bar's Gemini pill reloads. */
export const GEMINI_CHANGED = 'pythia:gemini'

export function geminiChanged(): void {
  window.dispatchEvent(new Event(GEMINI_CHANGED))
}

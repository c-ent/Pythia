import { LlmError, type ChatModel, type FetchFn } from '../ask/llm.js'
import { createGeminiModel } from '../ask/gemini.js'
import { openSecret, sealSecret, type SealedSecret } from '../security/secretBox.js'

/**
 * The Gemini key and request counter behind Settings › Gemini access (R16,
 * T39). The key is never returned, logged or stored in plain text: callers
 * see whether one is set, where it comes from and its last 4 characters.
 */

/** Associated data for the sealed key, so the ciphertext cannot pass for another secret. */
const KEY_CONTEXT = 'pythia:gemini_api_key'
/** The day the counter uses (R16: Asia/Taipei date). */
export const USAGE_TIME_ZONE = 'Asia/Taipei'
const TEST_TIMEOUT_MS = 15_000

export interface StoredGeminiKey extends SealedSecret {
  last4: string
  savedAt: Date
}

export interface GeminiKeyStore {
  get(): Promise<StoredGeminiKey | null>
  /** Replaces the saved key (there is at most one). */
  save(key: StoredGeminiKey): Promise<void>
  clear(): Promise<void>
}

export interface GeminiUsageStore {
  /** Adds one request to `day` (`YYYY-MM-DD`). */
  increment(day: string): Promise<void>
  get(day: string): Promise<number>
}

export type GeminiKeySource = 'env' | 'settings'

/**
 * - `secrets_key_missing`: a key is saved but `PYTHIA_SECRETS_KEY` is not set.
 * - `undecryptable`: a key is saved but `PYTHIA_SECRETS_KEY` cannot open it
 *   (another key, say after a restore); it is treated as no key.
 */
export type GeminiKeyWarning = 'secrets_key_missing' | 'undecryptable'

export interface GeminiStatus {
  /** A usable key exists (from `.env` or a saved one that opens). */
  configured: boolean
  source: GeminiKeySource | null
  /** Last 4 characters of the key in use, or null. */
  last4: string | null
  /** When the saved key was saved; null without one. */
  savedAt: Date | null
  /** A saved key exists while `GEMINI_API_KEY` in `.env` wins over it. */
  envOverridesSaved: boolean
  /** `PYTHIA_SECRETS_KEY` is set, so a key can be saved. */
  canSave: boolean
  warning: GeminiKeyWarning | null
  model: string
  usedToday: number
}

export type GeminiTestError = 'no_key' | 'invalid_key' | 'rate_limited' | 'unreachable' | 'failed'
export type GeminiTestResult = { ok: true } | { ok: false; error: GeminiTestError }

export interface GeminiSettingsService {
  status(): Promise<GeminiStatus>
  /** Encrypts and saves the key. Throws `SecretsKeyMissingError` without `PYTHIA_SECRETS_KEY`. */
  save(apiKey: string): Promise<GeminiStatus>
  /** Removes the saved key; a `.env` key is untouched. */
  remove(): Promise<GeminiStatus>
  /** One minimal Gemini call with the key in use. */
  test(): Promise<GeminiTestResult>
  /** The answer model for the key in use, or null without one. Each HTTP request it sends is counted. */
  model(): Promise<ChatModel | null>
  /**
   * A usable key is set and the last Gemini call did not fail on the key
   * (R18 "Gemini available"). The key failure is kept in memory only: a
   * restart, a saved or removed key, or a call that gets through clears it.
   */
  available(): Promise<boolean>
}

export interface GeminiSettingsOptions {
  /** `GEMINI_API_KEY` from `.env`; wins over a saved key. */
  envKey: string | null
  /** `PYTHIA_SECRETS_KEY` from `.env`; null means keys cannot be saved. */
  secretsKey: Buffer | null
  geminiModel: string
  keys: GeminiKeyStore
  usage: GeminiUsageStore
  /** For tests; defaults to the global `fetch`. */
  fetch?: FetchFn
  /** For tests; the answer model's backoff wait. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
}

export class SecretsKeyMissingError extends Error {
  override name = 'SecretsKeyMissingError'
  constructor() {
    super('PYTHIA_SECRETS_KEY is not set')
  }
}

const last4 = (key: string): string => key.slice(-4)

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** `YYYY-MM-DD` of `ms` in Asia/Taipei. */
export function usageDay(ms: number): string {
  return dayFormat.format(new Date(ms))
}

/** Gemini answers a bad or revoked key with 400 (API_KEY_INVALID) or 401/403. */
const isKeyFailure = (status: number): boolean => status === 400 || status === 401 || status === 403

/** Maps a failed test call to what Settings shows. */
export function classifyTestError(error: unknown): GeminiTestError {
  if (!(error instanceof LlmError)) return 'failed'
  const { status } = error
  if (status === undefined) return 'unreachable'
  if (status === 429) return 'rate_limited'
  // Gemini answers a bad or revoked key with 400 (API_KEY_INVALID) or 401/403.
  if (status === 400 || status === 401 || status === 403) return 'invalid_key'
  if (status >= 500) return 'unreachable'
  return 'failed'
}

export function createGeminiSettings(options: GeminiSettingsOptions): GeminiSettingsService {
  const { envKey, secretsKey, keys, usage, geminiModel } = options
  const now = options.now ?? Date.now
  const log = options.log ?? ((message: string) => console.warn(message))
  const baseFetch: FetchFn = options.fetch ?? ((url, init) => fetch(url, init))

  type Resolved = { key: string; source: GeminiKeySource } | null

  async function resolve(): Promise<{ resolved: Resolved; stored: StoredGeminiKey | null; warning: GeminiKeyWarning | null }> {
    const stored = await keys.get()
    if (envKey !== null) return { resolved: { key: envKey, source: 'env' }, stored, warning: null }
    if (stored === null) return { resolved: null, stored, warning: null }
    if (secretsKey === null) return { resolved: null, stored, warning: 'secrets_key_missing' }
    const key = openSecret(secretsKey, stored, KEY_CONTEXT)
    if (key === null) return { resolved: null, stored, warning: 'undecryptable' }
    return { resolved: { key, source: 'settings' }, stored, warning: null }
  }

  async function usedToday(): Promise<number> {
    return usage.get(usageDay(now()))
  }

  async function status(): Promise<GeminiStatus> {
    const { resolved, stored, warning } = await resolve()
    return {
      configured: resolved !== null,
      source: resolved?.source ?? null,
      last4: resolved === null ? null : last4(resolved.key),
      savedAt: stored?.savedAt ?? null,
      envOverridesSaved: envKey !== null && stored !== null,
      canSave: secretsKey !== null,
      warning,
      model: geminiModel,
      usedToday: await usedToday(),
    }
  }

  // The last Gemini answer rejected the key. Memory only (R18 needs no schema change for it).
  let keyFailed = false

  /** Counts every HTTP request to Gemini, retries included: that is what the free tier counts. */
  const countingFetch: FetchFn = async (url, init) => {
    try {
      await usage.increment(usageDay(now()))
    } catch (error) {
      log(`gemini usage count failed: ${error instanceof Error ? error.name : 'unknown'}`)
    }
    const response = await baseFetch(url, init)
    // Same statuses as `classifyTestError` reads as `invalid_key`; 429 and 5xx say nothing about the key.
    if (response.ok) keyFailed = false
    else if (isKeyFailure(response.status)) keyFailed = true
    return response
  }

  return {
    status,

    async save(apiKey) {
      if (secretsKey === null) throw new SecretsKeyMissingError()
      const sealed = sealSecret(secretsKey, apiKey, KEY_CONTEXT)
      await keys.save({ ...sealed, last4: last4(apiKey), savedAt: new Date(now()) })
      keyFailed = false
      return status()
    },

    async remove() {
      await keys.clear()
      keyFailed = false
      return status()
    },

    async available() {
      if (keyFailed) return false
      return (await resolve()).resolved !== null
    },

    async test() {
      const { resolved } = await resolve()
      if (resolved === null) return { ok: false, error: 'no_key' }
      let answered = false
      const model = createGeminiModel({
        apiKey: resolved.key,
        model: geminiModel,
        retries: 0,
        timeoutMs: TEST_TIMEOUT_MS,
        fetch: async (url, init) => {
          const response = await countingFetch(url, init)
          if (response.ok) answered = true
          return response
        },
      })
      try {
        await model.generate({ system: 'Reply with the single word OK.', user: 'OK?' })
        return { ok: true }
      } catch (error) {
        // Gemini accepted the key even if the reply had no text.
        if (answered) return { ok: true }
        return { ok: false, error: classifyTestError(error) }
      }
    },

    async model() {
      const { resolved } = await resolve()
      if (resolved === null) return null
      return createGeminiModel({
        apiKey: resolved.key,
        model: geminiModel,
        fetch: countingFetch,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      })
    },
  }
}

/** In-memory stores for tests and for running without a database. */
export function createMemoryGeminiKeyStore(): GeminiKeyStore & { stored(): StoredGeminiKey | null } {
  let current: StoredGeminiKey | null = null
  return {
    async get() {
      return current === null ? null : { ...current }
    },
    async save(key) {
      current = { ...key }
    },
    async clear() {
      current = null
    },
    stored() {
      return current === null ? null : { ...current }
    },
  }
}

export function createMemoryGeminiUsageStore(): GeminiUsageStore {
  const days = new Map<string, number>()
  return {
    async increment(day) {
      days.set(day, (days.get(day) ?? 0) + 1)
    },
    async get(day) {
      return days.get(day) ?? 0
    },
  }
}

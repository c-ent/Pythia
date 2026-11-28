import { access, constants } from 'node:fs/promises'
import type { Pool } from 'pg'
import type { GeminiSettingsService } from '../settings/geminiSettings.js'
import type { StatusService } from '../sync/statusService.js'

export const HEALTH_CHECK_TIMEOUT_MS = 2_000
export const HEALTH_CACHE_MS = 30_000
export const OLLAMA_EMBED_MODEL = 'nomic-embed-text'
const GITHUB_RATE_LIMIT_URL = 'https://api.github.com/rate_limit'

type CheckState = 'ok' | 'broken' | 'off'

export interface ConnectionCheck {
  state: CheckState
  reason: string | null
  [detail: string]: unknown
}

export interface ConnectionChecks {
  postgres: ConnectionCheck
  ollama: ConnectionCheck
  gemini: ConnectionCheck
  github: ConnectionCheck
  vault: ConnectionCheck
  sources: ConnectionCheck
  oracle: ConnectionCheck
}

export type CheckHealth = 'ok' | 'broken'
export type OverallHealth = 'ok' | 'warning' | 'broken'

export interface HealthSnapshot {
  checkedAt: string
  health: CheckHealth
  checks: ConnectionChecks
}

export interface ConnectionChecksOptions {
  pool: Pick<Pool, 'query'>
  ollamaUrl: string
  gemini: Pick<GeminiSettingsService, 'status' | 'available'>
  githubToken: string | null
  vaultPath: string | null
  status: Pick<StatusService, 'status'>
  oci?: { checkHealth(signal?: AbortSignal): Promise<{ state: CheckState; reason: string | null }> } | null
  fetch?: typeof fetch
  access?: (path: string, mode?: number) => Promise<void>
  now?: () => number
  timeoutMs?: number
  cacheMs?: number
}

const ok = (): ConnectionCheck => ({ state: 'ok', reason: null })
const off = (): ConnectionCheck => ({ state: 'off', reason: null })
const safeError = (error: unknown): string => {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) return error.name
  return 'UnknownError'
}

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      const error = new Error('Health check timed out')
      error.name = 'TimeoutError'
      reject(error)
    }, timeoutMs)
    timer.unref?.()
  })
  return Promise.race([task(controller.signal), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw Object.assign(new Error('Health check HTTP error'), { name: `Http${response.status}` })
  }
  return response.json()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasModel(value: unknown, field: string): boolean {
  if (!isRecord(value) || !Array.isArray(value[field])) return false
  return value[field].some((entry: unknown) => {
    if (!isRecord(entry)) return false
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
    return name === OLLAMA_EMBED_MODEL || name.startsWith(`${OLLAMA_EMBED_MODEL}:`)
  })
}

async function readJson(fetchFn: typeof fetch, url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetchFn(url, { headers, signal })
  return responseJson(response)
}

/** Checks upstream connections independently and caches the complete snapshot for 30 seconds. */
export function createConnectionChecks(options: ConnectionChecksOptions) {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const cacheMs = options.cacheMs ?? HEALTH_CACHE_MS
  const fetchFn = options.fetch ?? fetch
  const check = (task: (signal: AbortSignal) => Promise<ConnectionCheck>): Promise<ConnectionCheck> =>
    withTimeout(task, timeoutMs).catch((error: unknown) => ({ state: 'broken', reason: safeError(error) }))

  async function refresh(): Promise<HealthSnapshot> {
    const [postgres, ollama, gemini, github, vault, sourceStatus, oracle] = await Promise.all([
      check(async () => {
        await options.pool.query('SELECT 1')
        return ok()
      }),
      check(async (signal) => {
        const base = options.ollamaUrl.replace(/\/+$/, '')
        const [tags, running] = await Promise.all([
          readJson(fetchFn, `${base}/api/tags`, signal),
          readJson(fetchFn, `${base}/api/ps`, signal),
        ])
        const modelInstalled = hasModel(tags, 'models')
        const loadedModels = isRecord(running) && Array.isArray(running.models) ? running.models : []
        const loadedEmbedding = loadedModels.find((entry: unknown) => {
          if (!isRecord(entry)) return false
          const name = typeof entry.name === 'string' ? entry.name : typeof entry.model === 'string' ? entry.model : ''
          return name === OLLAMA_EMBED_MODEL || name.startsWith(`${OLLAMA_EMBED_MODEL}:`)
        })
        const modelLoaded = loadedEmbedding !== undefined
        const modelMemoryBytes =
          loadedEmbedding !== undefined && isRecord(loadedEmbedding) && typeof loadedEmbedding.size_vram === 'number'
            ? loadedEmbedding.size_vram
            : loadedEmbedding !== undefined && isRecord(loadedEmbedding) && typeof loadedEmbedding.size === 'number'
              ? loadedEmbedding.size
              : 0
        if (!modelInstalled) return { state: 'broken', reason: 'ModelNotInstalled', modelInstalled, modelLoaded, modelMemoryBytes }
        return { state: 'ok', reason: null, modelInstalled, modelLoaded, modelMemoryBytes }
      }),
      check(async () => {
        const status = await options.gemini.status()
        if (!status.configured) return off()
        if (!(await options.gemini.available())) return { state: 'broken', reason: 'KeyUnavailable' }
        return ok()
      }),
      options.githubToken === null
        ? Promise.resolve(off())
        : check(async (signal) => {
            const body = await readJson(fetchFn, GITHUB_RATE_LIMIT_URL, signal, {
              Accept: 'application/vnd.github+json',
              Authorization: `Bearer ${options.githubToken}`,
              'User-Agent': 'pythia',
              'X-GitHub-Api-Version': '2022-11-28',
            })
            const rate = isRecord(body) && isRecord(body.rate) ? body.rate : null
            if (rate === null || typeof rate.remaining !== 'number') {
              return { state: 'broken', reason: 'InvalidRateLimitResponse' }
            }
            return { state: 'ok', reason: null, remainingCore: rate.remaining }
          }),
      options.vaultPath === null
        ? Promise.resolve(off())
        : check(async () => {
            await (options.access ?? access)(options.vaultPath!, constants.R_OK)
            return ok()
          }),
      check(async () => {
        const status = await options.status.status()
        const sources = status.sources
        const failedSources = sources.filter((source) => source.state === 'error')
        return {
          state: failedSources.length > 0 ? 'broken' : 'ok',
          reason: failedSources.length === 0 ? null : `${failedSources.length} source(s) error`,
          states: sources.map((source) => ({ id: source.id, state: source.state, reason: source.reason })),
        }
      }),
      options.oci == null ? Promise.resolve(off()) : check((signal) => options.oci!.checkHealth(signal)),
    ])

    const checks: ConnectionChecks = { postgres, ollama, gemini, github, vault, sources: sourceStatus, oracle }
    // Source sync failures are reported by the Sync status pill, not as a server outage.
    const serverChecks = [postgres, ollama, gemini, github, vault, oracle]
    return {
      checkedAt: new Date(now()).toISOString(),
      health: serverChecks.some((entry) => entry.state === 'broken') ? 'broken' : 'ok',
      checks,
    }
  }

  let cached: HealthSnapshot | null = null
  let cachedAt = 0
  let pending: Promise<HealthSnapshot> | null = null

  return {
    async read(): Promise<HealthSnapshot> {
      const timestamp = now()
      if (cached !== null && timestamp - cachedAt < cacheMs) return cached
      if (pending !== null) return pending
      pending = refresh()
      try {
        cached = await pending
        cachedAt = now()
        return cached
      } finally {
        pending = null
      }
    },
  }
}


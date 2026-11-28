import { readFile } from 'node:fs/promises'
import type { OciConfig } from '../../config.js'
import { parseOciPrivateKey, signOciRequest } from './signer.js'

export const OCI_REGION_RE = /^[a-z]{2,6}-[a-z0-9-]+-\d+$/

export type OciService = 'identity' | 'iaas' | 'limits' | 'telemetry' | 'usageapi'

export type OciHealthCheck = {
  state: 'ok' | 'broken' | 'off'
  reason: string | null
}

export interface OciRequestOptions {
  service: OciService
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: unknown
  signal?: AbortSignal
}

export interface OciClientDeps {
  fetch?: typeof fetch
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  now?: () => number
}

export class OciConfigError extends Error {
  override name = 'OciConfigError'
}

export class OciKeyFileError extends Error {
  constructor(name: 'KeyFileMissing' | 'KeyFileUnreadable' | 'InvalidKeyFile', message: string) {
    super(message)
    this.name = name
  }
}

export class OciHttpError extends Error {
  readonly status: number
  constructor(status: number, clockSkew = false) {
    super(`OCI API HTTP ${status}`)
    this.status = status
    this.name = clockSkew ? 'ClockSkew' : `Http${status}`
  }
}

export class OciResponseError extends Error {
  override name = 'InvalidOciResponse'
}

const SERVICE_HOSTS: Record<OciService, (region: string) => string> = {
  identity: (region) => `identity.${region}.oci.oraclecloud.com`,
  iaas: (region) => `iaas.${region}.oraclecloud.com`,
  limits: (region) => `limits.${region}.oraclecloud.com`,
  telemetry: (region) => `telemetry.${region}.oraclecloud.com`,
  usageapi: (region) => `usageapi.${region}.oci.oraclecloud.com`,
}

/** Returns Oracle's regional API hostname for the given service, rejecting invalid regions. */
export function ociEndpointHost(service: OciService, region: string): string {
  if (!OCI_REGION_RE.test(region)) {
    throw new OciConfigError('Invalid OCI region')
  }
  return SERVICE_HOSTS[service](region)
}

function isConfiguredOci(config: OciConfig | null): config is OciConfig {
  return (
    config !== null &&
    config.tenancyId.trim().length > 0 &&
    config.userId.trim().length > 0 &&
    config.fingerprint.trim().length > 0 &&
    config.region.trim().length > 0 &&
    config.keyFile.trim().length > 0
  )
}

/** Returns a safe error class name for OCI failures without leaking OCIDs or secrets. */
export function safeOciReason(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)) {
    return error.name
  }
  return 'UnknownError'
}

function isClockSkewResponse(status: number, bodyText: string): boolean {
  if (status !== 401) return false
  return /clock\s*skew|date.*skew|skew|time.*difference/i.test(bodyText)
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, 4096)
  } catch {
    return ''
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface OciClient {
  isConfigured(): boolean
  request<T = unknown>(options: OciRequestOptions): Promise<T>
  checkHealth(signal?: AbortSignal): Promise<OciHealthCheck>
}

/** Signed read-only client for Oracle Cloud Infrastructure REST APIs. */
export function createOciClient(config: OciConfig | null, deps: OciClientDeps = {}): OciClient {
  const fetchFn = deps.fetch ?? fetch
  const readFileFn = deps.readFile ?? ((path, encoding) => readFile(path, encoding))
  const now = deps.now ?? Date.now

  async function loadPrivateKey(keyFile: string) {
    let pem: string
    try {
      pem = await readFileFn(keyFile, 'utf8')
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new OciKeyFileError('KeyFileMissing', 'OCI key file is missing')
      }
      throw new OciKeyFileError('KeyFileUnreadable', 'OCI key file is unreadable')
    }
    return parseOciPrivateKey(pem)
  }

  async function request<T = unknown>(options: OciRequestOptions): Promise<T> {
    if (!isConfiguredOci(config)) {
      throw new OciConfigError('OCI client is not configured')
    }
    const host = ociEndpointHost(options.service, config.region)
    const privateKey = await loadPrivateKey(config.keyFile)

    const url = new URL(`https://${host}${options.path}`)
    if (options.query !== undefined) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value)
      }
    }

    const bodyText = options.body === undefined ? undefined : JSON.stringify(options.body)
    const signed = signOciRequest(
      {
        tenancyId: config.tenancyId,
        userId: config.userId,
        fingerprint: config.fingerprint,
        privateKey,
      },
      {
        method: options.method,
        url,
        date: new Date(now()).toUTCString(),
        ...(bodyText === undefined ? {} : { body: bodyText, contentType: 'application/json' }),
      },
    )

    const response = await fetchFn(url.toString(), {
      method: options.method,
      headers: {
        accept: 'application/json',
        ...signed.headers,
      },
      ...(bodyText === undefined ? {} : { body: bodyText }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (!response.ok) {
      const snippet = response.status === 401 ? await readErrorSnippet(response) : ''
      if (response.status !== 401) {
        await response.body?.cancel().catch(() => {})
      }
      throw new OciHttpError(response.status, isClockSkewResponse(response.status, snippet))
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new OciResponseError('Invalid JSON response from OCI API')
    }
  }

  return {
    isConfigured: () => isConfiguredOci(config),
    request,
    async checkHealth(signal?: AbortSignal): Promise<OciHealthCheck> {
      if (!isConfiguredOci(config)) return { state: 'off', reason: null }
      try {
        const result = await request({
          service: 'identity',
          method: 'GET',
          path: `/20160918/tenancies/${encodeURIComponent(config.tenancyId)}`,
          ...(signal === undefined ? {} : { signal }),
        })
        if (!isPlainObject(result)) {
          return { state: 'broken', reason: 'InvalidOciResponse' }
        }
        return { state: 'ok', reason: null }
      } catch (error) {
        return { state: 'broken', reason: safeOciReason(error) }
      }
    },
  }
}

import { ApiError, apiFetch } from './client'

// Mirrors `/api/devices` (server/src/routes/devices.ts) and `/api/mcp-token`
// (server/src/routes/mcpToken.ts), R15.

/** A signed-in device: one server-side session. Dates are ISO. */
export interface Device {
  id: number
  name: string
  userAgent: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  /** True for the session of this browser. */
  current: boolean
}

/** Same limit as the server's `MAX_DEVICE_NAME`. */
export const MAX_DEVICE_NAME = 80

/** `env` until the first rotation, `database` after it, `none` when no token is set. */
export type McpTokenSource = 'env' | 'database' | 'none'

export interface McpTokenStatus {
  source: McpTokenSource
  last4: string | null
  rotatedAt: string | null
}

export interface RotatedMcpToken {
  /** The new token. The server never shows it again. */
  token: string
  last4: string
  rotatedAt: string
}

const badResponse = (): ApiError => new ApiError(500, 'bad_response', 'Unexpected response')

function isDevice(value: unknown): value is Device {
  if (value === null || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  return (
    typeof d.id === 'number' &&
    typeof d.name === 'string' &&
    typeof d.lastSeenAt === 'string' &&
    typeof d.current === 'boolean'
  )
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json()
    if (body !== null && typeof body === 'object') return body as Record<string, unknown>
  } catch {
    // Not JSON; refused below.
  }
  throw badResponse()
}

export async function getDevices(signal?: AbortSignal): Promise<Device[]> {
  const body = await readJson(await apiFetch('/api/devices', { signal }))
  if (!Array.isArray(body.devices)) throw badResponse()
  return body.devices.filter(isDevice)
}

export async function renameDevice(id: number, name: string): Promise<Device> {
  const res = await apiFetch(`/api/devices/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  const body = await readJson(res)
  if (!isDevice(body.device)) throw badResponse()
  return body.device
}

/** Signs one device out. One already gone (signed out elsewhere) counts as signed out. */
export async function signOutDevice(id: number): Promise<void> {
  try {
    await apiFetch(`/api/devices/${id}`, { method: 'DELETE' })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return
    throw error
  }
}

/** Ends every session, this one included. */
export async function signOutEverywhere(): Promise<void> {
  await apiFetch('/api/devices/sign-out-all', { method: 'POST' })
}

export async function getMcpTokenStatus(signal?: AbortSignal): Promise<McpTokenStatus> {
  const body = await readJson(await apiFetch('/api/mcp-token', { signal }))
  const source = body.source
  if (source !== 'env' && source !== 'database' && source !== 'none') throw badResponse()
  return {
    source,
    last4: typeof body.last4 === 'string' ? body.last4 : null,
    rotatedAt: typeof body.rotatedAt === 'string' ? body.rotatedAt : null,
  }
}

/** Makes a new MCP token; the old one stops working at once. */
export async function rotateMcpToken(): Promise<RotatedMcpToken> {
  const body = await readJson(await apiFetch('/api/mcp-token/rotate', { method: 'POST' }))
  if (typeof body.token !== 'string' || typeof body.last4 !== 'string' || typeof body.rotatedAt !== 'string') {
    throw badResponse()
  }
  return { token: body.token, last4: body.last4, rotatedAt: body.rotatedAt }
}

/** Window event fired after a device was renamed or signed out, so the top bar count reloads. */
export const DEVICES_CHANGED = 'pythia:devices'

export function devicesChanged(): void {
  window.dispatchEvent(new Event(DEVICES_CHANGED))
}

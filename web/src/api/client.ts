/** An API failure. `status` 0 means the server could not be reached. */
export class ApiError extends Error {
  override name = 'ApiError'
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const signedOutListeners = new Set<() => void>()

/** Called whenever the server says the session is missing or expired. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener)
  return () => {
    signedOutListeners.delete(listener)
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null
  return Number(value)
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  const fallback = { code: 'http_' + res.status, message: res.statusText || 'Request failed' }
  try {
    const body: unknown = await res.json()
    if (body !== null && typeof body === 'object' && 'error' in body) {
      const error = body.error
      if (error !== null && typeof error === 'object' && 'code' in error && 'message' in error) {
        return { code: String(error.code), message: String(error.message) }
      }
    }
  } catch {
    // Not JSON; use the fallback.
  }
  return fallback
}

/** Same-origin fetch that turns non-2xx answers into `ApiError`. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch (error) {
    // A cancelled request is not a network failure; callers check their signal.
    if (init.signal?.aborted === true) throw error
    throw new ApiError(0, 'network', 'Can’t reach the server')
  }
  if (res.ok) return res
  const { code, message } = await readError(res)
  if (res.status === 401 && code === 'unauthenticated') for (const listener of signedOutListeners) listener()
  throw new ApiError(res.status, code, message, parseRetryAfter(res.headers.get('retry-after')))
}

/** True when the browser holds a valid session cookie. */
export async function getSession(): Promise<boolean> {
  try {
    await apiFetch('/api/session')
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false
    throw error
  }
}

export async function login(pw: string): Promise<void> {
  await apiFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The server expects one field, named "password".
    body: JSON.stringify(Object.fromEntries([['password', pw]])),
  })
}

export async function logout(): Promise<void> {
  await apiFetch('/api/logout', { method: 'POST' })
}

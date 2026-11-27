import { describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, getSession, login, onSignedOut } from './client'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => handler(url, init))
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('apiFetch', () => {
  it('returns ok responses and sends same-origin credentials', async () => {
    const fn = stubFetch(() => json(200, { ok: true }))
    const res = await apiFetch('/api/recent')
    expect(await res.json()).toEqual({ ok: true })
    const init = fn.mock.calls[0]?.[1]
    expect(init?.credentials).toBe('same-origin')
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
  })

  it('turns the error envelope into ApiError with Retry-After', async () => {
    stubFetch(() =>
      json(429, { error: { code: 'rate_limited', message: 'Too many login attempts' } }, { 'retry-after': '120' }),
    )
    const error = await apiFetch('/api/login').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 120 })
  })

  it('falls back when the body is not the error envelope', async () => {
    stubFetch(() => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }))
    await expect(apiFetch('/api/recent')).rejects.toMatchObject({ status: 502, code: 'http_502', retryAfterSeconds: null })
  })

  it('reports an unreachable server as status 0', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(apiFetch('/api/recent')).rejects.toMatchObject({ status: 0, code: 'network' })
  })

  it('rethrows a cancelled request instead of reporting a network failure', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    const controller = new AbortController()
    controller.abort()
    const error = await apiFetch('/api/search', { signal: controller.signal }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ name: 'AbortError' })
  })

  it('tells listeners when the session is gone', async () => {
    stubFetch(() => json(401, { error: { code: 'unauthenticated', message: 'Sign in required' } }))
    const listener = vi.fn()
    const off = onSignedOut(listener)
    await expect(apiFetch('/api/search')).rejects.toBeInstanceOf(ApiError)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    await expect(apiFetch('/api/search')).rejects.toBeInstanceOf(ApiError)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not treat a wrong password as a lost session', async () => {
    stubFetch(() => json(401, { error: { code: 'invalid_credentials', message: 'Wrong password' } }))
    const listener = vi.fn()
    const off = onSignedOut(listener)
    await expect(login('nope')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' })
    expect(listener).not.toHaveBeenCalled()
    off()
  })
})

describe('session calls', () => {
  it('getSession follows the authenticated flag, and is false on 401', async () => {
    stubFetch(() => json(200, { authenticated: true }))
    expect(await getSession()).toBe(true)
    const signedOut = vi.fn()
    const stop = onSignedOut(signedOut)
    stubFetch(() => json(200, { authenticated: false }))
    expect(await getSession()).toBe(false)
    expect(signedOut).not.toHaveBeenCalled()
    stop()
    stubFetch(() => new Response('not json', { status: 200 }))
    expect(await getSession()).toBe(false)
    stubFetch(() => json(401, { error: { code: 'unauthenticated', message: 'Sign in required' } }))
    expect(await getSession()).toBe(false)
  })

  it('getSession rethrows other failures', async () => {
    stubFetch(() => json(500, { error: { code: 'internal', message: 'Internal server error' } }))
    await expect(getSession()).rejects.toMatchObject({ status: 500 })
  })

  it('login posts the typed value as JSON', async () => {
    const fn = stubFetch(() => new Response(null, { status: 204 }))
    await login('typed value')
    const [url, init] = fn.mock.calls[0] ?? []
    expect(url).toBe('/api/login')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))['password']).toBe('typed value')
  })
})

import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import type { SearchService } from '../search/searchService.js'
import { createSessionManager, type SessionStore } from '../security/sessionStore.js'
import { SESSION_COOKIE, type AuthDeps } from './auth.js'
import { testAuth } from './testAuth.js'

const search = {
  async recent() {
    return []
  },
} as unknown as SearchService
const ask = {} as AskService

const iphone =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1'
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

const closers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(closers.map((close) => close()))
})

async function start(auth: AuthDeps): Promise<string> {
  const server = createServer(createApp({ search, ask, auth }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A fresh auth setup with the same store, as after a server restart. */
function restarted(auth: AuthDeps, store: SessionStore): AuthDeps {
  if (auth.login === null) throw new Error('login is off')
  return { ...auth, login: { ...auth.login, sessions: createSessionManager({ store, passwordHash: 'test-hash' }) } }
}

interface DeviceBody {
  id: number
  name: string
  userAgent: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  current: boolean
}

async function setup() {
  const t = await testAuth(mac)
  const other = await t.sessions.issue(iphone)
  const base = await start(t.auth)
  const as = (cookie: string) => (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })
  const otherCookie = `${SESSION_COOKIE}=${other.token}`
  return { ...t, base, me: as(t.cookie), them: as(otherCookie), otherCookie, otherId: other.session.id }
}

const listDevices = async (call: (path: string) => Promise<Response>): Promise<DeviceBody[]> => {
  const res = await call('/devices')
  expect(res.status).toBe(200)
  return ((await res.json()) as { devices: DeviceBody[] }).devices
}

describe('devices routes', () => {
  it('need a session', async () => {
    const { base } = await setup()
    expect((await fetch(`${base}/api/devices`)).status).toBe(401)
    expect((await fetch(`${base}/api/devices/1`, { method: 'DELETE' })).status).toBe(401)
    expect((await fetch(`${base}/api/devices/sign-out-all`, { method: 'POST' })).status).toBe(401)
  })

  it('lists signed-in devices with the current one marked, newest first, and no token', async () => {
    const { me, otherId, cookie } = await setup()
    const res = await me('/devices')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text()
    expect(text).not.toContain(cookie.split('=')[1])
    const { devices } = JSON.parse(text) as { devices: DeviceBody[] }
    expect(devices.map((d) => [d.name, d.current])).toEqual([
      ['iPhone · Safari', false],
      ['Mac · Chrome', true],
    ])
    expect(devices[0]?.id).toBe(otherId)
    expect(Object.keys(devices[0] ?? {}).sort()).toEqual(['createdAt', 'current', 'expiresAt', 'id', 'lastSeenAt', 'name', 'userAgent'])
  })

  it('renames a device', async () => {
    const { me, otherId } = await setup()
    const res = await me(`/devices/${otherId}`, { method: 'PATCH', body: JSON.stringify({ name: '  Kitchen iPhone  ' }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { device: DeviceBody }).device).toMatchObject({ id: otherId, name: 'Kitchen iPhone', current: false })
    expect((await listDevices(me)).find((d) => d.id === otherId)?.name).toBe('Kitchen iPhone')
  })

  it('refuses a bad rename', async () => {
    const { me, otherId } = await setup()
    const patch = (path: string, body: unknown) => me(path, { method: 'PATCH', body: JSON.stringify(body) })
    expect((await patch(`/devices/${otherId}`, { name: '   ' })).status).toBe(400)
    expect((await patch(`/devices/${otherId}`, { name: 'x'.repeat(81) })).status).toBe(400)
    expect((await patch(`/devices/${otherId}`, {})).status).toBe(400)
    expect((await patch('/devices/abc', { name: 'Ok' })).status).toBe(400)
    expect((await patch('/devices/999', { name: 'Ok' })).status).toBe(404)
  })

  it('signs out another device, which then gets 401, also after a restart', async () => {
    const { auth, store, me, them, otherId, otherCookie } = await setup()
    expect((await them('/devices')).status).toBe(200)
    const res = await me(`/devices/${otherId}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect((await them('/devices')).status).toBe(401)
    expect((await listDevices(me)).map((d) => d.current)).toEqual([true])
    expect((await me(`/devices/${otherId}`, { method: 'DELETE' })).status).toBe(404)

    const again = await start(restarted(auth, store))
    expect(await sessionProbe(again, otherCookie)).toEqual({ authenticated: false })
    expect((await fetch(`${again}/api/devices`, { headers: { cookie: otherCookie } })).status).toBe(401)
  })

  it('clears the cookie when a device signs itself out', async () => {
    const { me, them, otherId } = await setup()
    const mine = (await listDevices(me)).find((d) => d.current)
    const res = await me(`/devices/${mine?.id ?? 0}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
    expect((await me('/devices')).status).toBe(401)
    expect((await listDevices(them)).map((d) => d.id)).toEqual([otherId])
  })

  it('signs out everywhere, also after a restart', async () => {
    const { auth, store, me, them, cookie, otherCookie } = await setup()
    const res = await me('/devices/sign-out-all', { method: 'POST' })
    expect(res.status).toBe(204)
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`))
    expect((await me('/devices')).status).toBe(401)
    expect((await them('/devices')).status).toBe(401)

    const again = await start(restarted(auth, store))
    for (const c of [cookie, otherCookie]) {
      expect(await sessionProbe(again, c)).toEqual({ authenticated: false })
      expect((await fetch(`${again}/api/devices`, { headers: { cookie: c } })).status).toBe(401)
    }
  })

  it('keeps a session working across a restart', async () => {
    const { auth, store, cookie } = await setup()
    const again = await start(restarted(auth, store))
    expect(await sessionProbe(again, cookie)).toEqual({ authenticated: true })
  })
})

async function sessionProbe(base: string, cookie: string): Promise<unknown> {
  const res = await fetch(`${base}/api/session`, { headers: { cookie } })
  expect(res.status).toBe(200)
  return res.json()
}

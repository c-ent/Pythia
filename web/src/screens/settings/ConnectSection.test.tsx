import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '../../api/devices'
import { DEVICES_CHANGED } from '../../api/devices'
import { claudeCodeCommand, formatLastSeen, mcpServerUrl } from './connect'
import { ConnectSection } from './ConnectSection'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noContent = () => new Response(null, { status: 204 })

type Handler = (init?: RequestInit) => Response | Promise<Response>

/** Routes are keyed `METHOD url`; unknown routes answer 404. */
function stubApi(routes: Record<string, Handler>) {
  const calls: { key: string; init?: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, init })
    const route = routes[key]
    if (route === undefined) return json(404, { error: { code: 'not_found', message: 'Not found' } })
    return route(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

const NOW = Date.now()
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

function device(id: number, name: string, extra: Partial<Device> = {}): Device {
  return {
    id,
    name,
    userAgent: 'Mozilla/5.0',
    createdAt: ago(5 * 86_400_000),
    lastSeenAt: ago(0),
    expiresAt: new Date(NOW + 20 * 86_400_000).toISOString(),
    current: false,
    ...extra,
  }
}

/** A server that keeps devices and the token in memory, like the real one. */
function stubServer({
  devices = [device(1, 'Windows · Chrome', { current: true }), device(2, 'iPhone · Safari', { lastSeenAt: ago(2 * 3_600_000) })],
  token = { source: 'env', last4: 'c91a', rotatedAt: null } as { source: string; last4: string | null; rotatedAt: string | null },
  failRotate = false,
}: { devices?: Device[]; token?: { source: string; last4: string | null; rotatedAt: string | null }; failRotate?: boolean } = {}) {
  let stored = [...devices]
  let status = token
  // Built by concatenation so no token-like literal is committed.
  const newToken = 'n3wT0k3n' + 'x'.repeat(30) + 'Zq9w'
  const perDevice: Record<string, Handler> = {}
  for (const d of devices) {
    perDevice[`PATCH /api/devices/${d.id}`] = (init) => {
      const body = JSON.parse(String(init?.body)) as { name: string }
      const found = stored.find((x) => x.id === d.id)
      if (found === undefined) return json(404, { error: { code: 'not_found', message: 'No such signed-in device' } })
      found.name = body.name
      return json(200, { device: found })
    }
    perDevice[`DELETE /api/devices/${d.id}`] = () => {
      const before = stored.length
      stored = stored.filter((x) => x.id !== d.id)
      return before === stored.length ? json(404, { error: { code: 'not_found', message: 'x' } }) : noContent()
    }
  }
  const all = {
    'GET /api/devices': () => json(200, { devices: stored }),
    'GET /api/mcp-token': () => json(200, status),
    'POST /api/mcp-token/rotate': () => {
      if (failRotate) return json(500, { error: { code: 'internal', message: 'Boom' } })
      status = { source: 'database', last4: 'Zq9w', rotatedAt: new Date(NOW).toISOString() }
      return json(200, { token: newToken, last4: 'Zq9w', rotatedAt: status.rotatedAt })
    },
    'POST /api/devices/sign-out-all': () => {
      stored = []
      return noContent()
    },
    ...perDevice,
  } satisfies Record<string, Handler>
  return { ...stubApi(all), newToken }
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

const devicesCard = () => screen.getByRole('region', { name: 'Devices' })

describe('ConnectSection', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'onLine')
    Reflect.deleteProperty(navigator, 'clipboard')
    vi.restoreAllMocks()
  })

  it('says /mcp works only over Tailscale, gives the four setup steps and offers no .mcp.json', async () => {
    stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    await screen.findByDisplayValue(/c91a$/)
    expect(screen.getByText(/Only over Tailscale/)).toBeTruthy()
    expect(screen.queryByText(/Only the token protects it/)).toBeNull()
    const setup = within(screen.getByRole('region', { name: 'Set up Claude Code on a computer' }))
    const steps = setup.getAllByRole('listitem')
    expect(steps).toHaveLength(4)
    expect(steps[0]?.textContent).toMatch(/Install the Tailscale app and sign in to the same Tailscale account/)
    expect(steps[1]?.textContent).toMatch(/tailscale status/)
    expect(steps[2]?.textContent).toContain(claudeCodeCommand(`${window.location.origin}/mcp`))
    expect(steps[3]?.textContent).toMatch(/403.*did not go over Tailscale/)
    expect(steps[3]?.textContent).toMatch(/401.*token is wrong or was rotated/)
    expect(setup.getByText(/Phones and tablets need none of this/)).toBeTruthy()
    // Only the command: no project file that could hold the token and get committed.
    expect(document.body.textContent).not.toMatch(/\.mcp\.json|mcpServers/)
    expect(screen.queryByRole('button', { name: 'Copy .mcp.json' })).toBeNull()
  })

  it('shows the MCP URL on this origin, the token’s last 4 only and the tools', async () => {
    stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    const tokenField = (await screen.findByDisplayValue(/c91a$/)) as HTMLInputElement
    expect(tokenField.value).toBe('••••••••••••c91a')
    expect(screen.getByLabelText('Server URL')).toHaveProperty('value', `${window.location.origin}/mcp`)
    expect(screen.getByText(/PYTHIA_MCP_TOKEN in \.env/)).toBeTruthy()
    const tools = within(screen.getByRole('region', { name: 'Tools exposed' }))
    for (const name of ['search', 'get_document', 'recent_changes', 'list_repos', 'get_repo_overview']) {
      expect(tools.getByText(name)).toBeTruthy()
    }
    // The snippet holds a placeholder, never a token.
    expect(screen.getByText(/claude mcp add --transport http pythia/).textContent).toContain('<your token>')
  })

  it('rotates after confirming, shows the new token once and puts it in the snippets', async () => {
    const server = stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    await screen.findByDisplayValue(/c91a$/)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(server.calls.some((c) => c.key === 'POST /api/mcp-token/rotate')).toBe(false)
    expect(screen.getByRole('alertdialog').textContent).toMatch(/stops working at once/)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate now' }))
    const field = (await screen.findByLabelText('New MCP token')) as HTMLInputElement
    expect(field.value).toBe(server.newToken)
    expect(screen.getByText(/it is not shown again/)).toBeTruthy()
    expect(screen.getByDisplayValue('••••••••••••Zq9w')).toBeTruthy()
    expect(screen.getByText(/claude mcp add --transport/).textContent).toContain(`Bearer ${server.newToken}`)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // Nothing about the token is kept on the device.
    expect(JSON.stringify({ ...localStorage })).not.toContain(server.newToken)
  })

  it('cancelling the rotation sends nothing', async () => {
    const server = stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    await screen.findByDisplayValue(/c91a$/)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(server.calls.some((c) => c.key === 'POST /api/mcp-token/rotate')).toBe(false)
  })

  it('reports a failed rotation and keeps the old token shown', async () => {
    stubServer({ failRotate: true })
    render(<ConnectSection onSignedOut={() => {}} />)
    await screen.findByDisplayValue(/c91a$/)
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rotate now' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t rotate the token/)
    expect(screen.getByDisplayValue('••••••••••••c91a')).toBeTruthy()
    expect(screen.queryByLabelText('New MCP token')).toBeNull()
  })

  it('says when no token is set', async () => {
    stubServer({ token: { source: 'none', last4: null, rotatedAt: null } })
    render(<ConnectSection onSignedOut={() => {}} />)
    expect(await screen.findByDisplayValue('Not set')).toBeTruthy()
    expect(screen.getByText(/MCP clients are refused/)).toBeTruthy()
  })

  it('copies the server URL', async () => {
    stubServer()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => ({ writeText }) })
    render(<ConnectSection onSignedOut={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy server URL' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/mcp`))
  })

  it('lists devices, this one first, with last seen', async () => {
    stubServer({
      devices: [
        device(2, 'iPhone · Safari', { lastSeenAt: ago(2 * 3_600_000) }),
        device(1, 'Windows · Chrome', { current: true }),
      ],
    })
    render(<ConnectSection onSignedOut={() => {}} />)
    await within(devicesCard()).findByText('Windows · Chrome')
    const items = within(devicesCard()).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]!.textContent).toMatch(/Windows · Chrome.*This device.*Last seen now/)
    expect(items[1]!.textContent).toMatch(/iPhone · Safari.*Last seen 2h ago/)
  })

  it('renames a device and tells the top bar', async () => {
    const server = stubServer()
    const changed = vi.fn()
    window.addEventListener(DEVICES_CHANGED, changed)
    render(<ConnectSection onSignedOut={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename iPhone · Safari' }))
    const input = screen.getByLabelText('Device name')
    fireEvent.change(input, { target: { value: '  My iPhone  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(devicesCard()).findByText('My iPhone')).toBeTruthy()
    const patch = server.calls.find((c) => c.key === 'PATCH /api/devices/2')
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ name: 'My iPhone' })
    expect(changed).toHaveBeenCalled()
    window.removeEventListener(DEVICES_CHANGED, changed)
  })

  it('refuses an empty name', async () => {
    const server = stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rename iPhone · Safari' }))
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByRole('alert').textContent).toMatch(/Give the device a name/)
    expect(server.calls.some((c) => c.key.startsWith('PATCH'))).toBe(false)
  })

  it('signs out another device and keeps this one signed in', async () => {
    const server = stubServer()
    const onSignedOut = vi.fn()
    render(<ConnectSection onSignedOut={onSignedOut} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out iPhone · Safari' }))
    await waitFor(() => expect(within(devicesCard()).queryByText('iPhone · Safari')).toBeNull())
    expect(server.calls.some((c) => c.key === 'DELETE /api/devices/2')).toBe(true)
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('signing out this device goes back to Login', async () => {
    stubServer()
    const onSignedOut = vi.fn()
    render(<ConnectSection onSignedOut={onSignedOut} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Windows · Chrome' }))
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce())
  })

  it('signs out everywhere after confirming', async () => {
    const server = stubServer()
    const onSignedOut = vi.fn()
    render(<ConnectSection onSignedOut={onSignedOut} />)
    await within(devicesCard()).findByText('Windows · Chrome')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }))
    expect(server.calls.some((c) => c.key === 'POST /api/devices/sign-out-all')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all devices' }))
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce())
    expect(server.calls.some((c) => c.key === 'POST /api/devices/sign-out-all')).toBe(true)
  })

  it('shows a load error for the device list', async () => {
    stubApi({
      'GET /api/mcp-token': () => json(200, { source: 'env', last4: 'c91a', rotatedAt: null }),
      'GET /api/devices': () => json(500, { error: { code: 'internal', message: 'Boom' } }),
    })
    render(<ConnectSection onSignedOut={() => {}} />)
    expect((await within(devicesCard()).findByRole('alert')).textContent).toMatch(/Couldn’t load your devices/)
  })

  it('needs a connection: nothing is fetched and the buttons are off', () => {
    setOnline(false)
    const server = stubServer()
    render(<ConnectSection onSignedOut={() => {}} />)
    expect(screen.getByText(/Devices and the MCP token need a connection/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Rotate' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Sign out everywhere' }) as HTMLButtonElement).disabled).toBe(true)
    expect(server.fn).not.toHaveBeenCalled()
  })
})

describe('connect helpers', () => {
  it('formats last seen', () => {
    const now = Date.parse('2026-11-26T12:00:00Z')
    expect(formatLastSeen('2026-11-26T11:59:30Z', now)).toBe('now')
    expect(formatLastSeen('2026-11-26T11:45:00Z', now)).toBe('15 min ago')
    expect(formatLastSeen('2026-11-26T09:00:00Z', now)).toBe('3h ago')
    expect(formatLastSeen('2026-11-24T12:00:00Z', now)).toBe('2d ago')
    expect(formatLastSeen('not a date', now)).toBe('not a date')
  })

  it('builds the URL and the Claude snippets', () => {
    const url = mcpServerUrl('https://pythia.example.ts.net')
    expect(url).toBe('https://pythia.example.ts.net/mcp')
    expect(claudeCodeCommand(url)).toBe(
      'claude mcp add --transport http pythia https://pythia.example.ts.net/mcp --header "Authorization: Bearer <your token>"',
    )
  })
})

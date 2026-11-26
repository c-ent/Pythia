import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile } from '../../api/profile'
import { PROFILE_KEY, readProfile } from '../../profile/profile'
import { ProfileSection } from './ProfileSection'

const SERVER: Profile = {
  displayName: 'Cent',
  timeZone: 'Asia/Taipei',
  vaultName: 'Notes',
  theme: 'system',
  openingMode: 'search',
  notePreviews: true,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A server that keeps the profile in memory and trims it, like the real one. */
function stubProfileServer(initial: Profile = SERVER, { failGet = false } = {}) {
  let stored = initial
  const puts: Profile[] = []
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const sent = JSON.parse(String(init.body)) as Profile
      puts.push(sent)
      stored = { ...sent, displayName: sent.displayName.trim() }
      return json(200, { profile: stored })
    }
    if (failGet) return json(500, { error: { code: 'internal', message: 'Boom' } })
    return json(200, { profile: stored })
  })
  vi.stubGlobal('fetch', fn)
  return { fn, puts }
}

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
}

const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement

describe('ProfileSection', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'onLine')
    vi.restoreAllMocks()
  })

  it('fills the form from the server and enables Save only after a change', async () => {
    stubProfileServer()
    render(<ProfileSection onSignOut={() => {}} />)
    const name = (await screen.findByDisplayValue('Cent')) as HTMLInputElement
    expect(screen.getByRole('link', { name: 'Profile' }).textContent).toBe('C')
    expect(save().disabled).toBe(true)
    fireEvent.change(name, { target: { value: 'Cent E' } })
    expect(save().disabled).toBe(false)
  })

  it('saves the opening mode and note previews and caches the result', async () => {
    const server = stubProfileServer()
    render(<ProfileSection onSignOut={() => {}} />)
    await screen.findByDisplayValue('Cent')
    fireEvent.click(screen.getByRole('radio', { name: 'Ask' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Note previews in results/ }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '  Ada  ' } })
    fireEvent.click(save())
    await waitFor(() => expect(server.puts).toHaveLength(1))
    expect(server.puts[0]).toMatchObject({ displayName: 'Ada', openingMode: 'ask', notePreviews: false })
    await waitFor(() => expect(readProfile().displayName).toBe('Ada'))
    expect(JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null')).toMatchObject({ openingMode: 'ask' })
  })

  it('refuses a time zone the browser does not know', async () => {
    const server = stubProfileServer()
    render(<ProfileSection onSignOut={() => {}} />)
    await screen.findByDisplayValue('Cent')
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Mars/Olympus' } })
    fireEvent.click(save())
    expect((await screen.findByRole('alert')).textContent).toMatch(/Pick a time zone/)
    expect(server.puts).toHaveLength(0)
  })

  it('falls back to the copy on this device when loading fails', async () => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...SERVER, displayName: 'Cached' }))
    stubProfileServer(SERVER, { failGet: true })
    render(<ProfileSection onSignOut={() => {}} />)
    expect(await screen.findByText(/Couldn’t load your profile/)).toBeTruthy()
    expect(screen.getByDisplayValue('Cached')).toBeTruthy()
  })

  it('needs a connection to save', () => {
    setOnline(false)
    const server = stubProfileServer()
    render(<ProfileSection onSignOut={() => {}} />)
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Ada' } })
    expect(save().disabled).toBe(true)
    expect(screen.getByText(/Profile changes need a connection/)).toBeTruthy()
    expect(server.fn).not.toHaveBeenCalled()
  })
})

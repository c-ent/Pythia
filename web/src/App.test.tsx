import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const unauthenticated = () => json(401, { error: { code: 'unauthenticated', message: 'Sign in required' } })

describe('App', () => {
  it('shows the login screen when there is no session', async () => {
    vi.stubGlobal('fetch', async () => unauthenticated())
    render(<App />)
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })

  it('shows the shell when the session is valid', async () => {
    vi.stubGlobal('fetch', async () => json(200, { authenticated: true }))
    render(<App />)
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  it('logs in, then signs out back to the login screen', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === '/api/login' || url === '/api/logout') return new Response(null, { status: 204 })
      return unauthenticated()
    })
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'right one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy()

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0] as HTMLElement)
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })

  it('offers a retry when the server cannot be reached', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('returns to the login screen when a later request finds the session gone', async () => {
    let signedIn = true
    vi.stubGlobal('fetch', async () => (signedIn ? json(200, { authenticated: true }) : unauthenticated()))
    render(<App />)
    await screen.findByRole('navigation', { name: 'Main' })
    signedIn = false
    const { apiFetch } = await import('./api/client')
    await apiFetch('/api/recent').catch(() => {})
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROFILE } from './api/profile'
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
    expect(await screen.findAllByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  it('logs in, then signs out back to the login screen', async () => {
    let signedIn = false
    vi.stubGlobal('fetch', async (url: string) => {
      if (url === '/api/login' || url === '/api/logout') {
        signedIn = url === '/api/login'
        return new Response(null, { status: 204 })
      }
      // The shell loads the profile once signed in; a 401 here would end the session.
      if (url === '/api/profile' && signedIn) return json(200, { profile: DEFAULT_PROFILE })
      // Home's cards load recent changes and recent queries.
      if (url.startsWith('/api/recent') && signedIn) return json(200, { documents: [], queries: [] })
      return unauthenticated()
    })
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'right one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findAllByRole('navigation', { name: 'Main' })).toBeTruthy()

    // Sign out lives on Settings › Profile.
    fireEvent.click(screen.getAllByRole('link', { name: 'Settings' })[0] as HTMLElement)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
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
    await screen.findAllByRole('navigation', { name: 'Main' })
    signedIn = false
    const { apiFetch } = await import('./api/client')
    await apiFetch('/api/recent').catch(() => {})
    expect(await screen.findByLabelText('Password')).toBeTruthy()
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { LoginScreen } from './LoginScreen'
import { formatWait, loginErrorMessage } from './loginErrors'

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('loginErrorMessage', () => {
  it.each([
    [new ApiError(401, 'invalid_credentials', 'x'), 'Wrong password. Try again.'],
    [new ApiError(429, 'rate_limited', 'x', 600), 'Too many attempts. Try again in 10 minutes.'],
    [new ApiError(429, 'rate_limited', 'x', 61), 'Too many attempts. Try again in 2 minutes.'],
    [new ApiError(429, 'rate_limited', 'x', 30), 'Too many attempts. Try again in 30 seconds.'],
    [new ApiError(429, 'rate_limited', 'x'), 'Too many attempts. Wait a few minutes and try again.'],
    [new ApiError(0, 'network', 'x'), 'Can’t reach the server. Check your connection and try again.'],
    [new ApiError(500, 'internal', 'x'), 'Something went wrong. Try again.'],
    [new Error('x'), 'Something went wrong. Try again.'],
  ])('maps %o', (error, message) => {
    expect(loginErrorMessage(error)).toBe(message)
  })

  it('points to the setup command when login is not configured', () => {
    expect(loginErrorMessage(new ApiError(503, 'auth_not_configured', 'x'))).toMatch(/auth-env/)
  })

  it('formats waits', () => {
    expect(formatWait(1)).toBe('1 second')
    expect(formatWait(60)).toBe('1 minute')
    expect(formatWait(900)).toBe('15 minutes')
  })
})

describe('LoginScreen', () => {
  const type = (text: string) => fireEvent.change(screen.getByLabelText('Password'), { target: { value: text } })
  const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

  it('keeps the button disabled until something is typed', () => {
    render(<LoginScreen onSignedIn={() => {}} />)
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true)
    type('abc')
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', false)
  })

  it('shows the error, marks the field invalid, and keeps the user on the form', async () => {
    vi.stubGlobal('fetch', async () => json(401, { error: { code: 'invalid_credentials', message: 'Wrong password' } }))
    const onSignedIn = vi.fn()
    render(<LoginScreen onSignedIn={onSignedIn} />)
    type('wrong guess')
    submit()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Wrong password. Try again.')
    expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).not.toContain('wrong guess')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('explains the rate limit with the wait from Retry-After', async () => {
    vi.stubGlobal('fetch', async () =>
      json(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '840' }),
    )
    render(<LoginScreen onSignedIn={() => {}} />)
    type('again')
    submit()
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many attempts. Try again in 14 minutes.')
  })

  it('shows and hides the password', () => {
    render(<LoginScreen onSignedIn={() => {}} />)
    const field = screen.getByLabelText('Password')
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(field.getAttribute('type')).toBe('password')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(field.getAttribute('type')).toBe('text')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(field.getAttribute('type')).toBe('password')
  })

  it('shows the logo and the 30-day note', () => {
    render(<LoginScreen onSignedIn={() => {}} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Pythia' })).toBeTruthy()
    expect(screen.getByText(/stays signed in for 30 days/)).toBeTruthy()
  })

  it('signs in on success', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }))
    const onSignedIn = vi.fn()
    render(<LoginScreen onSignedIn={onSignedIn} />)
    type('right one')
    submit()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

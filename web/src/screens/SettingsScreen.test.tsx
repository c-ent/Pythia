import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'

// The Gemini access section has its own tests in settings/GeminiSection.test.tsx.
// Offline storage moved to the Pinned page (PinnedScreen.test.tsx).

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('SettingsScreen', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: { code: 'not_found', message: 'Not found' } })),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signs out', () => {
    const onSignOut = vi.fn()
    render(<SettingsScreen section="profile" onSignOut={onSignOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('shows the Gemini access section', () => {
    render(<SettingsScreen section="gemini" onSignOut={() => {}} />)
    expect(screen.getByRole('heading', { level: 2, name: 'Gemini access' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'API key' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Kept away from Gemini' })).toBeTruthy()
  })

  it('shows the Server section', () => {
    render(<SettingsScreen section="server" onSignOut={() => {}} />)
    expect(screen.getByRole('link', { name: 'Server' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toBeTruthy()
  })

  it('includes the Server tab and no longer has a Storage tab', () => {
    render(<SettingsScreen section="profile" onSignOut={() => {}} />)
    const tabs = screen.getByRole('navigation', { name: 'Settings' })
    expect(tabs.textContent).toContain('Server')
    expect(tabs.textContent).not.toContain('Storage')
  })
})

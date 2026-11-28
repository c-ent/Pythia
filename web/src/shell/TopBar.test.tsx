import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MobileTopBar } from './Navigation'
import { HealthDot, TopBar } from './TopBar'

describe('HealthDot', () => {
  it('links to Settings › Server with a label naming broken checks when broken online', () => {
    render(<HealthDot online reachable health="broken" brokenChecks={['Ollama', 'PostgreSQL']} />)
    const link = screen.getByRole('link', { name: 'Server health broken: Ollama, PostgreSQL' })
    expect(link.getAttribute('href')).toBe('/settings/server')
  })

  it('uses a fallback label when broken check names have not loaded yet', () => {
    render(<HealthDot online reachable health="broken" />)
    expect(screen.getByRole('link', { name: 'Server health broken' })).toBeTruthy()
  })

  it('renders nothing on ok, warning, offline, or unreachable', () => {
    const { rerender } = render(<HealthDot online reachable health="ok" brokenChecks={['Ollama']} />)
    expect(screen.queryByRole('link')).toBeNull()

    rerender(<HealthDot online reachable health="warning" brokenChecks={['Ollama']} />)
    expect(screen.queryByRole('link')).toBeNull()

    rerender(<HealthDot online={false} reachable health="broken" brokenChecks={['Ollama']} />)
    expect(screen.queryByRole('link')).toBeNull()

    rerender(<HealthDot online reachable={false} health="broken" brokenChecks={['Ollama']} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders the dot in both TopBar and MobileTopBar only when broken', () => {
    const { rerender } = render(
      <>
        <TopBar online reachable health="broken" brokenChecks={['Ollama']} />
        <MobileTopBar online reachable health="broken" brokenChecks={['Ollama']} />
      </>,
    )
    expect(screen.getAllByRole('link', { name: 'Server health broken: Ollama' })).toHaveLength(2)

    rerender(
      <>
        <TopBar online reachable health="warning" brokenChecks={['Ollama']} />
        <MobileTopBar online reachable health="warning" brokenChecks={['Ollama']} />
      </>,
    )
    expect(screen.queryByRole('link', { name: /Server health broken/ })).toBeNull()
  })
})

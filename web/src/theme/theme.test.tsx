import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import html from '../../index.html?raw'
import script from '../../public/theme-init.js?raw'
import { ThemeSwitch } from './ThemeSwitch'
import { THEME_KEY, applyTheme, readThemeChoice, resolveTheme, setThemeChoice, watchTheme } from './theme'

type Listener = (event: { matches: boolean }) => void

/** A controllable `matchMedia` for `(prefers-color-scheme: dark)`. */
function stubSystemTheme(initialDark: boolean) {
  let dark = initialDark
  const listeners = new Set<Listener>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('dark') ? dark : false
      },
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    })),
  )
  return {
    set(next: boolean) {
      dark = next
      for (const listener of listeners) listener({ matches: next })
    },
  }
}

function addThemeColorMeta(): HTMLMetaElement {
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = '#000000'
  document.head.append(meta)
  return meta
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
})

describe('theme choice', () => {
  it('defaults to System, which follows prefers-color-scheme', () => {
    stubSystemTheme(true)
    expect(readThemeChoice()).toBe('system')
    expect(applyTheme()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('persists the choice on the device and applies it at once', () => {
    stubSystemTheme(false)
    const meta = addThemeColorMeta()
    setThemeChoice('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(readThemeChoice()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(meta.content).toBe('#0f0f10')
    setThemeChoice('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(meta.content).toBe('#17191e')
  })

  it('ignores an unknown stored value', () => {
    stubSystemTheme(false)
    localStorage.setItem(THEME_KEY, 'sepia')
    expect(readThemeChoice()).toBe('system')
  })

  it('follows the system while the choice is System, and not otherwise', () => {
    const system = stubSystemTheme(false)
    const stop = watchTheme()
    applyTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
    system.set(true)
    expect(document.documentElement.dataset.theme).toBe('dark')

    setThemeChoice('light')
    system.set(false)
    system.set(true)
    expect(document.documentElement.dataset.theme).toBe('light')
    stop()
  })

  it('picks up a choice made in another tab', () => {
    stubSystemTheme(false)
    const stop = watchTheme()
    localStorage.setItem(THEME_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    stop()
  })
})

describe('first-paint script', () => {
  const run = (): void => new Function(script)()

  it.each([
    ['dark', false, 'dark'],
    ['light', true, 'light'],
    ['system', true, 'dark'],
    [null, false, 'light'],
  ] as const)('stored %s with system dark %s paints %s', (stored, systemDark, expected) => {
    stubSystemTheme(systemDark)
    if (stored !== null) localStorage.setItem(THEME_KEY, stored)
    run()
    expect(document.documentElement.dataset.theme).toBe(expected)
  })

  it('is loaded in <head> before the app script', () => {
    const init = html.indexOf('/theme-init.js')
    expect(init).toBeGreaterThan(-1)
    expect(init).toBeLessThan(html.indexOf('</head>'))
    expect(init).toBeLessThan(html.indexOf('/src/main.tsx'))
  })
})

describe('ThemeSwitch', () => {
  const radio = (name: string): HTMLInputElement => screen.getByRole<HTMLInputElement>('radio', { name })

  it('shows the saved choice and saves a new one', () => {
    stubSystemTheme(false)
    setThemeChoice('light')
    const onChange = vi.fn()
    render(<ThemeSwitch onChange={onChange} />)
    expect(radio('Light').checked).toBe(true)

    fireEvent.click(radio('Dark'))
    expect(radio('Dark').checked).toBe(true)
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(onChange).toHaveBeenCalledWith('dark')

    act(() => setThemeChoice('system'))
    expect(radio('System').checked).toBe(true)
  })
})

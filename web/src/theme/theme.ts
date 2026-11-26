import { useSyncExternalStore } from 'react'

/**
 * Light / Dark / System theme, cached on this device in localStorage so the
 * first paint (public/theme-init.js, which uses the same key and rules) and
 * offline use get the right theme. The Profile on the server (T30) also holds
 * the choice; it is written here when the profile loads.
 */
export type ThemeChoice = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

export const THEME_KEY = 'pythia.theme'
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

/** `<meta name="theme-color">` per theme: the `nav` token (the page frame). Keep in step with index.css. */
export const THEME_COLOR: Record<Theme, string> = { light: '#17191e', dark: '#0f0f10' }

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system'
}

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return isThemeChoice(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

export function resolveTheme(choice: ThemeChoice, prefersDark = systemPrefersDark()): Theme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light'
  return choice
}

/** Sets `data-theme` on `<html>` and the browser's theme color. */
export function applyTheme(choice: ThemeChoice = readThemeChoice()): Theme {
  const theme = resolveTheme(choice)
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
  return theme
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Saves the choice on this device and applies it at once. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Private mode or storage full: the theme still applies until reload.
  }
  applyTheme(choice)
  notify()
}

/**
 * Keeps the page in step with the system theme while the choice is System,
 * and with a choice made in another tab. Returns a function that stops it.
 */
export function watchTheme(): () => void {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
  const onSystemChange = (): void => {
    if (readThemeChoice() === 'system') applyTheme('system')
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== THEME_KEY) return
    applyTheme()
    notify()
  }
  media?.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onStorage)
  return () => {
    media?.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The saved choice, re-rendering when it changes. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, readThemeChoice, () => 'system')
}

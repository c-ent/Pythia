import { describe, expect, it } from 'vitest'
import html from '../../index.html?raw'
import init from '../../public/theme-init.js?raw'
import viteConfig from '../../vite.config.ts?raw'
import css from '../index.css?raw'
import { THEME_COLOR } from './theme'

// Reads the real token values from index.css, so a token change that breaks
// contrast fails here (ui.md: every text color at least 4.5:1, both themes).

function block(start: RegExp): string {
  const at = css.search(start)
  if (at < 0) throw new Error(`block ${start} not found in index.css`)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error('unbalanced block')
}

function tokens(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const [, name, value] of body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    map.set(name, value.toLowerCase())
  }
  return map
}

const light = tokens(block(/@theme\s*\{/))
const dark = new Map([...light, ...tokens(block(/:root\[data-theme='dark'\]\s*\{/))])

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// [text, backgrounds it sits on]. Add a pair when a token is used as text on a new background.
const PAIRS: [string, string[]][] = [
  ['ink', ['canvas', 'surface', 'raised', 'mark']],
  ['muted', ['canvas', 'surface', 'raised']],
  ['accent-ink', ['canvas', 'surface', 'raised']],
  ['danger', ['canvas', 'surface', 'raised']],
  ['warning', ['canvas', 'surface', 'raised']],
  ['success', ['canvas', 'surface', 'raised']],
  ['on-accent', ['accent']],
  ['on-strong', ['strong']],
  ['nav-ink', ['nav', 'nav-raised', 'glow-offline']],
  ['nav-muted', ['nav', 'nav-raised']],
  ['accent', ['nav', 'nav-raised']],
]

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('%s theme tokens', (_name, theme) => {
  it.each(PAIRS.flatMap(([text, backs]) => backs.map((back) => [text, back] as const)))(
    '%s on %s is at least 4.5:1',
    (text, back) => {
      const fg = theme.get(text)
      const bg = theme.get(back)
      expect(fg, `--color-${text}`).toBeDefined()
      expect(bg, `--color-${back}`).toBeDefined()
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5)
    },
  )
})

describe('theme colors outside CSS', () => {
  it('the browser theme color is the nav token in each theme', () => {
    expect(THEME_COLOR.light).toBe(light.get('nav'))
    expect(THEME_COLOR.dark).toBe(dark.get('nav'))
  })

  it('index.html, theme-init.js and the manifest use the same frame colors', () => {
    expect(html).toContain(`content="${THEME_COLOR.light}"`)
    expect(init).toContain(`'${THEME_COLOR.light}'`)
    expect(init).toContain(`'${THEME_COLOR.dark}'`)
    expect(viteConfig).toContain(`const FRAME = '${THEME_COLOR.light}'`)
  })

  it('no font or asset is loaded from another host', () => {
    expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic/)
  })
})

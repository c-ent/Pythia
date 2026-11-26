import { ApiError } from '../api/client'
import type { LlmExclusion, LlmExclusionKind } from '../api/settings'

/** Same limit as the server (`MAX_PATH_LENGTH` in server/src/settings/settingsService.ts). */
const MAX_PATH_LENGTH = 1024
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

/**
 * Mirrors the server's `normalizeVaultPath`: `\` becomes `/`, empty and `.`
 * segments go, spaces around the path are trimmed. Null for an empty path or one with `..`.
 */
export function normalizeVaultPath(input: string): string | null {
  const segments = input
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return segments.join('/')
}

/** Checks a typed path before it is sent; returns the clean path or a message for the owner. */
export function checkExclusionPath(
  kind: LlmExclusionKind,
  input: string,
  list: readonly LlmExclusion[],
): { path: string } | { error: string } {
  if (input.trim() === '') return { error: 'Type a folder or note path.' }
  if (CONTROL_CHARACTER.test(input) || input.length > MAX_PATH_LENGTH) return { error: 'That path can’t be used.' }
  const path = normalizeVaultPath(input)
  if (path === null) return { error: 'Use a path inside the vault, without “..”.' }
  if (kind === 'note' && !/\.md$/i.test(path)) return { error: 'A note path ends in .md, for example Journal/2026-11-26.md.' }
  const key = path.toLowerCase()
  if (list.some((item) => item.kind === kind && item.path.toLowerCase() === key)) {
    return { error: 'That is already on the list.' }
  }
  return { path }
}

export function exclusionErrorMessage(error: unknown, action: 'load' | 'save'): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
    if (error.status === 404) return 'This list isn’t available on this server yet.'
    if (error.status === 400 && action === 'save') return `The server refused the list: ${error.message}`
  }
  return action === 'load' ? 'Couldn’t load the list. Try again.' : 'Couldn’t save the change. Try again.'
}

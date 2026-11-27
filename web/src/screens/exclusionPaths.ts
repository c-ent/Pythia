import { ApiError } from '../api/client'
import type { LlmExclusion, LlmExclusionKind } from '../api/settings'

/** Same limit as the server (`MAX_PATH_LENGTH` in server/src/settings/settingsService.ts). */
const MAX_PATH_LENGTH = 1024
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
// Mirrors server/src/ingest/noteTags.ts and REPO_NAME_PATTERN in server/src/ingest/repoConfig.ts.
const TAG_BODY = /^[\p{L}\p{N}_/-]+$/u
const DIGITS_ONLY = /^\p{N}+$/u
const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** The only `path` of a `keep` rule. */
export const KEEP_RULE_PATH = 'keep'

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

/** Mirrors the server's `normalizeTag`: without `#` or a trailing `/`, lower case; null when not an Obsidian tag. */
export function normalizeTag(input: string): string | null {
  const tag = input.trim().replace(/^#+/, '').replace(/\/+$/, '').toLowerCase()
  if (tag === '' || !TAG_BODY.test(tag)) return null
  if (tag.split('/').some((part) => part === '')) return null
  if (DIGITS_ONLY.test(tag.replace(/\//g, ''))) return null
  return tag
}

/** Mirrors the server's `normalizeRepoName`: a `repos.json` name, trimmed, not ending in `.git`. */
export function normalizeRepoName(input: string): string | null {
  const name = input.trim()
  return REPO_NAME_PATTERN.test(name) && !name.toLowerCase().endsWith('.git') ? name : null
}

function normalizeRulePath(kind: LlmExclusionKind, input: string): string | null {
  switch (kind) {
    case 'folder':
    case 'note':
      return normalizeVaultPath(input)
    case 'tag':
      return normalizeTag(input)
    case 'repo':
      return normalizeRepoName(input)
    case 'keep':
      return KEEP_RULE_PATH
  }
}

const EMPTY: Record<LlmExclusionKind, string> = {
  folder: 'Type a folder or note path.',
  note: 'Type a folder or note path.',
  tag: 'Type a tag.',
  repo: 'Type a repo name.',
  keep: '',
}

const INVALID: Record<LlmExclusionKind, string> = {
  folder: 'Use a path inside the vault, without “..”.',
  note: 'Use a path inside the vault, without “..”.',
  tag: 'A tag has only letters, digits, “_”, “-” and “/”, and not only digits, for example private or private/health.',
  repo: 'A repo name has up to 100 letters, digits, “.”, “_” or “-”, starts with a letter or digit and doesn’t end in .git.',
  keep: '',
}

/** Checks a typed rule before it is sent; returns the clean path or a message for the owner. */
export function checkExclusionPath(
  kind: LlmExclusionKind,
  input: string,
  list: readonly LlmExclusion[],
): { path: string } | { error: string } {
  if (kind !== 'keep' && input.trim() === '') return { error: EMPTY[kind] }
  if (CONTROL_CHARACTER.test(input) || input.length > MAX_PATH_LENGTH) return { error: 'That path can’t be used.' }
  const path = normalizeRulePath(kind, input)
  if (path === null) return { error: INVALID[kind] }
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

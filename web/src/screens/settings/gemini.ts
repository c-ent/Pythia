import { ApiError } from '../../api/client'
import type { GeminiStatus, GeminiTestResult } from '../../api/gemini'
import type { RepoInfo } from '../../api/repos'
import type { CountedLlmExclusion, LlmExclusion, LlmExclusionKind } from '../../api/settings'
import { formatDate, plural } from '../../repos/format'
import { DRIVE_ROOT_RULE_PATH, KEEP_RULE_PATH } from '../exclusionPaths'

/** Same bounds as the server's `geminiKeyInputSchema`; they only stop obvious mistakes before sending. */
const MIN_KEY_LENGTH = 20
const MAX_KEY_LENGTH = 256

/**
 * One row of the "Kept away from Gemini" list. Locked rows are the rules the
 * server keeps; allowed rows are repos and Google Keep without a rule, and
 * rules unlocked while the page is open, so they can be locked again.
 */
export interface RuleRow {
  kind: LlmExclusionKind
  path: string
  locked: boolean
  /** Documents the rule covers, or null when not known (an allowed row the server does not count). */
  documents: number | null
}

const KIND_ORDER: Record<LlmExclusionKind, number> = { folder: 0, note: 1, tag: 2, repo: 3, keep: 4, gdrive: 5 }

export const KIND_LABELS: Record<LlmExclusionKind, string> = {
  folder: 'Folder',
  note: 'Note',
  tag: 'Tag',
  repo: 'Repo',
  keep: 'Google Keep',
  gdrive: 'Google Drive',
}

const ruleKey = (rule: LlmExclusion): string => `${rule.kind}:${rule.path.toLowerCase()}`

export const sameRule = (a: LlmExclusion, b: LlmExclusion): boolean => ruleKey(a) === ruleKey(b)

/**
 * The rows to show: every rule on the list (locked), rules unlocked on this
 * visit, every indexed repo and Google Keep (allowed unless a rule locks them).
 * Sorted like the server: folders, notes, tags, repos, then Keep.
 */
export function buildRuleRows(
  list: readonly CountedLlmExclusion[],
  released: readonly CountedLlmExclusion[],
  repos: readonly RepoInfo[] | null,
): RuleRow[] {
  const rows = new Map<string, RuleRow>()
  for (const rule of list) rows.set(ruleKey(rule), { kind: rule.kind, path: rule.path, locked: true, documents: rule.documents })
  const addAllowed = (row: RuleRow): void => {
    if (!rows.has(ruleKey(row))) rows.set(ruleKey(row), row)
  }
  for (const rule of released) addAllowed({ kind: rule.kind, path: rule.path, locked: false, documents: rule.documents })
  for (const repo of repos ?? []) addAllowed({ kind: 'repo', path: repo.name, locked: false, documents: repo.files })
  addAllowed({ kind: 'keep', path: KEEP_RULE_PATH, locked: false, documents: null })
  return [...rows.values()].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    const left = a.path.toLowerCase()
    const right = b.path.toLowerCase()
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** How the rule reads in the list. */
export function ruleLabel(rule: LlmExclusion): string {
  switch (rule.kind) {
    case 'folder':
      return `${rule.path}/`
    case 'tag':
      return `#${rule.path}`
    case 'keep':
      return 'Google Keep'
    case 'gdrive':
      return rule.path === DRIVE_ROOT_RULE_PATH ? 'All of Google Drive' : `Drive: ${rule.path}/`
    default:
      return rule.path
  }
}

/** "12 notes" or "3 files"; null when the count is not known. */
export function countText(row: RuleRow): string | null {
  if (row.documents === null) return null
  return plural(row.documents, row.kind === 'repo' || row.kind === 'gdrive' ? 'file' : 'note')
}

/** Folder, note, tag and Drive rules can be taken off the list; repos and Keep stay as allowed rows. */
export const isRemovable = (row: RuleRow): boolean =>
  row.kind === 'folder' || row.kind === 'note' || row.kind === 'tag' || row.kind === 'gdrive'

/** Where the key in use comes from, in one line. */
export function keyStatusText(status: GeminiStatus): string {
  if (!status.configured) return 'No key yet. Ask answers with the local model or with snippets.'
  const ending = status.last4 === null ? 'A key' : `The key ending in ${status.last4}`
  if (status.source === 'env') return `${ending} comes from GEMINI_API_KEY in .env.`
  return status.savedAt === null
    ? `${ending} is saved here, encrypted.`
    : `${ending} was saved here on ${formatDate(status.savedAt)}, encrypted.`
}

export function keyWarningText(status: GeminiStatus): string | null {
  switch (status.warning) {
    case 'undecryptable':
      return 'A key is saved, but PYTHIA_SECRETS_KEY can’t open it (a different secrets key, for example after a restore). It is treated as no key: save it again.'
    case 'secrets_key_missing':
      return 'A key is saved, but PYTHIA_SECRETS_KEY is not set, so it can’t be used. Set it in .env and restart the server.'
    default:
      return null
  }
}

/** Checks a typed key before it is sent; returns the trimmed key or a message. */
export function checkKey(input: string): { key: string } | { error: string } {
  const key = input.trim()
  if (key === '') return { error: 'Paste a Gemini API key.' }
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    return { error: 'That doesn’t look like a Gemini API key. Copy it again from Google AI Studio.' }
  }
  return { key }
}

export function testResultText(result: GeminiTestResult): string {
  if (result.ok) return 'Gemini answered. The key works.'
  switch (result.error) {
    case 'invalid_key':
      return 'Invalid key: Gemini refused it. Check it and save it again.'
    case 'rate_limited':
      return 'Rate limited: Gemini says too many requests. Try again later.'
    case 'unreachable':
      return 'Unreachable: the server can’t reach Gemini right now. Try again later.'
    case 'no_key':
      return 'There is no key to test. Save one first.'
    default:
      return 'The test failed. Try again.'
  }
}

/** For failed calls to the Gemini settings routes. A 409 or 400 carries the server's own explanation. */
export function keyErrorMessage(error: unknown, what: string): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'Can’t reach the server. Check your connection and try again.'
    if (error.status === 404) return 'Gemini settings aren’t available on this server yet.'
    if (error.status === 409 || error.status === 400) return error.message
  }
  return `Couldn’t ${what}. Try again.`
}

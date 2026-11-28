import { normalizeDriveFolder } from './driveConfig.js'
import { REPO_NAME_PATTERN } from './repoConfig.js'
import { normalizeTag, tagCovers } from './noteTags.js'

/**
 * The "Kept away from Gemini" list (R3, R16). Every matching document gets
 * `allow_llm = false`; it stays searchable. Empty means everything may reach
 * Gemini; frontmatter `llm: false` keeps a note away regardless of the list.
 *
 * - `folder`, `note`: vault-relative paths of Obsidian notes.
 * - `tag`: Obsidian notes whose frontmatter `tags` or inline `#tag` is the
 *   tag or nested under it (`private` covers `#private/health`).
 * - `repo`: every document of the repo with that name ("Allow Ask to read
 *   this repo" switched off).
 * - `keep`: every Google Keep note; its `path` is always `keep`.
 * - `gdrive`: Google Drive documents (R19, T62). `path` is `/` for the whole
 *   Drive, else a Drive-relative folder whose files and subfolders it covers.
 */
export type LlmExclusionKind = 'folder' | 'note' | 'tag' | 'repo' | 'keep' | 'gdrive'

export const LLM_EXCLUSION_KINDS = [
  'folder',
  'note',
  'tag',
  'repo',
  'keep',
  'gdrive',
] as const satisfies readonly LlmExclusionKind[]

/** The only `path` of a `keep` rule. */
export const KEEP_RULE_PATH = 'keep'

/** The `path` of a `gdrive` rule that covers the whole Drive. No folder normalizes to it. */
export const DRIVE_ROOT_RULE_PATH = '/'

export interface LlmExclusion {
  kind: LlmExclusionKind
  /**
   * `folder` / `note`: vault-relative, `/`-separated, no leading `./` or `/`,
   * no trailing `/`. `tag`: lower case, without `#`. `repo`: the repo name.
   * `keep`: `keep`. `gdrive`: `/`, or a Drive folder without leading or
   * trailing `/`.
   */
  path: string
}

/** Where the list is kept. The Postgres version is `db/llmExclusionStore.ts`. */
export interface LlmExclusionStore {
  list(): Promise<LlmExclusion[]>
  /**
   * Replaces the whole list. The Postgres store also, in the same transaction,
   * sets `allow_llm = false` on every vault note the new list excludes (by
   * path or stored tag) and sets repo and Keep documents to match their rule
   * both ways, so a change holds as soon as it is saved. Giving vault notes
   * back needs their frontmatter, so that is left to `VaultIndexer.refreshAllowLlm`.
   */
  replace(list: readonly LlmExclusion[]): Promise<void>
  /** How many stored documents each rule covers, in the order given. */
  countDocuments(list: readonly LlmExclusion[]): Promise<number[]>
}

/**
 * Normalizes a vault-relative path: `\` becomes `/`, empty and `.` segments
 * go, surrounding spaces are trimmed. Null for an empty path or one with `..`.
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

/** A repo name as `repos.json` allows it (`REPO_NAME_PATTERN`, not ending in `.git`), trimmed; else null. */
export function normalizeRepoName(input: string): string | null {
  const name = input.trim()
  return REPO_NAME_PATTERN.test(name) && !name.toLowerCase().endsWith('.git') ? name : null
}

/** The rule's `path` in its stored form, or null when it is not valid for that kind. */
export function normalizeRulePath(kind: LlmExclusionKind, input: string): string | null {
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
    case 'gdrive':
      return normalizeDriveRulePath(input)
  }
}

/** `/` (or nothing) is the whole Drive; anything else must be a plain Drive folder path. */
export function normalizeDriveRulePath(input: string): string | null {
  if (/^\s*\/*\s*$/.test(input)) return DRIVE_ROOT_RULE_PATH
  return normalizeDriveFolder(input)
}

/**
 * True when a `gdrive` rule covers the Drive document at this mirror-relative
 * path: the whole Drive, or a folder it sits in at any depth. Ignores case, like
 * vault folder rules, so a lock never misses a file over spelling.
 */
export function isDriveLocked(relPath: string, exclusions: readonly LlmExclusion[]): boolean {
  const file = relPath.toLowerCase()
  return exclusions.some(
    (exclusion) =>
      exclusion.kind === 'gdrive' &&
      (exclusion.path === DRIVE_ROOT_RULE_PATH || file.startsWith(`${exclusion.path.toLowerCase()}/`)),
  )
}

/**
 * True when the vault note sits in an excluded folder, is itself excluded, or
 * carries an excluded tag (paths ignore case; `tags` are already lower case).
 */
export function isExcludedFromLlm(
  notePath: string,
  exclusions: readonly LlmExclusion[],
  tags: readonly string[] = [],
): boolean {
  const note = notePath.toLowerCase()
  return exclusions.some((exclusion) => {
    const path = exclusion.path.toLowerCase()
    switch (exclusion.kind) {
      case 'folder':
        return note.startsWith(`${path}/`)
      case 'note':
        return note === path
      case 'tag':
        return tags.some((tag) => tagCovers(tag, path))
      default:
        return false
    }
  })
}

/** True when a `repo` rule names this repo (ignoring case, as repo names are unique that way). */
export function isRepoLocked(repo: string, exclusions: readonly LlmExclusion[]): boolean {
  const name = repo.toLowerCase()
  return exclusions.some((exclusion) => exclusion.kind === 'repo' && exclusion.path.toLowerCase() === name)
}

/** True when the list holds the `keep` rule. */
export function isKeepLocked(exclusions: readonly LlmExclusion[]): boolean {
  return exclusions.some((exclusion) => exclusion.kind === 'keep')
}

const KIND_ORDER: Record<LlmExclusionKind, number> = { folder: 0, note: 1, tag: 2, repo: 3, keep: 4, gdrive: 5 }

function compareExclusions(a: LlmExclusion, b: LlmExclusion): number {
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  const left = a.path.toLowerCase()
  const right = b.path.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** Folders, notes, tags, repos, Keep, then Drive; within a kind by path ignoring case. */
export function sortExclusions(list: readonly LlmExclusion[]): LlmExclusion[] {
  return list.map((exclusion) => ({ kind: exclusion.kind, path: exclusion.path })).sort(compareExclusions)
}

/**
 * Normalizes every path, drops duplicates (ignoring case; the first spelling
 * wins) and sorts. Throws on a path `normalizeRulePath` rejects: callers
 * validate input before it gets here.
 */
export function cleanExclusions(list: readonly LlmExclusion[]): LlmExclusion[] {
  const seen = new Set<string>()
  const clean: LlmExclusion[] = []
  for (const exclusion of list) {
    const path = normalizeRulePath(exclusion.kind, exclusion.path)
    if (path === null) throw new Error('invalid exclusion path')
    const key = `${exclusion.kind}:${path.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    clean.push({ kind: exclusion.kind, path })
  }
  return sortExclusions(clean)
}

/**
 * In-memory store for tests and for running without a database. `count`
 * stands in for the document counts; without it every rule covers 0.
 */
export function createMemoryLlmExclusionStore(
  initial: readonly LlmExclusion[] = [],
  count: (exclusion: LlmExclusion) => number = () => 0,
): LlmExclusionStore {
  let items = sortExclusions(initial)
  return {
    async list() {
      return sortExclusions(items)
    },
    async replace(list) {
      items = sortExclusions(list)
    },
    async countDocuments(list) {
      return list.map(count)
    },
  }
}

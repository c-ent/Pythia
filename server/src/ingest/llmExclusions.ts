/**
 * The Gemini exclusion list (R3): vault folders and single notes whose
 * documents get `allow_llm = false`. Empty means every note may reach Gemini;
 * frontmatter `llm: false` keeps a note away regardless of the list.
 */
export type LlmExclusionKind = 'folder' | 'note'

export interface LlmExclusion {
  kind: LlmExclusionKind
  /** Vault-relative, `/`-separated, no leading `./` or `/`, no trailing `/`. */
  path: string
}

/** Where the list is kept. The Postgres version is `db/llmExclusionStore.ts`. */
export interface LlmExclusionStore {
  list(): Promise<LlmExclusion[]>
  /**
   * Replaces the whole list. The Postgres store also sets `allow_llm = false`
   * on every vault note the new list excludes, in the same transaction, so an
   * exclusion holds as soon as it is saved. Giving notes back needs their
   * frontmatter, so that is left to `VaultIndexer.refreshAllowLlm`.
   */
  replace(list: readonly LlmExclusion[]): Promise<void>
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

/** True when the note sits in an excluded folder or is itself excluded (case-insensitive). */
export function isExcludedFromLlm(notePath: string, exclusions: readonly LlmExclusion[]): boolean {
  const note = notePath.toLowerCase()
  return exclusions.some((exclusion) => {
    const path = exclusion.path.toLowerCase()
    return exclusion.kind === 'folder' ? note.startsWith(`${path}/`) : note === path
  })
}

function compareExclusions(a: LlmExclusion, b: LlmExclusion): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  const left = a.path.toLowerCase()
  const right = b.path.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/** Folders first, then notes, each by path ignoring case. */
export function sortExclusions(list: readonly LlmExclusion[]): LlmExclusion[] {
  return list.map((exclusion) => ({ kind: exclusion.kind, path: exclusion.path })).sort(compareExclusions)
}

/**
 * Normalizes every path, drops duplicates (ignoring case; the first spelling
 * wins) and sorts. Throws on a path `normalizeVaultPath` rejects: callers
 * validate input before it gets here.
 */
export function cleanExclusions(list: readonly LlmExclusion[]): LlmExclusion[] {
  const seen = new Set<string>()
  const clean: LlmExclusion[] = []
  for (const exclusion of list) {
    const path = normalizeVaultPath(exclusion.path)
    if (path === null) throw new Error('invalid exclusion path')
    const key = `${exclusion.kind}:${path.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    clean.push({ kind: exclusion.kind, path })
  }
  return sortExclusions(clean)
}

/** In-memory store for tests and for running without a database. */
export function createMemoryLlmExclusionStore(initial: readonly LlmExclusion[] = []): LlmExclusionStore {
  let items = sortExclusions(initial)
  return {
    async list() {
      return sortExclusions(items)
    },
    async replace(list) {
      items = sortExclusions(list)
    },
  }
}

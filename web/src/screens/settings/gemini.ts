import { ApiError } from '../../api/client'
import type { GeminiStatus, GeminiTestResult } from '../../api/gemini'
import type { RepoInfo } from '../../api/repos'
import type {
  CountedLlmExclusion,
  LlmExclusion,
  LlmExclusionCatalog,
  LlmExclusionKind,
} from '../../api/settings'
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

export type RuleAccess = 'allowed' | 'llm' | 'all'

const ACCESS_RANK: Record<RuleAccess, number> = { allowed: 0, llm: 1, all: 2 }

export const ruleAccess = (rule?: Pick<LlmExclusion, 'scope'>): RuleAccess =>
  rule === undefined ? 'allowed' : rule.scope === 'all' ? 'all' : 'llm'

export function strictestAccess(a: RuleAccess, b: RuleAccess): RuleAccess {
  return ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b
}

export function isAccessWeaker(candidate: RuleAccess, minimum: RuleAccess): boolean {
  return ACCESS_RANK[candidate] < ACCESS_RANK[minimum]
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

function compareIgnoreCase(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function parentCover(
  path: string,
  rules: readonly LlmExclusion[],
  rootRule?: LlmExclusion,
): { coveredByParent: string | null; inheritedAccess: RuleAccess } {
  let coveredByParent: string | null = rootRule === undefined ? null : DRIVE_ROOT_RULE_PATH
  let inheritedAccess: RuleAccess = ruleAccess(rootRule)
  const lower = path.toLowerCase()
  for (const rule of rules) {
    const prefix = `${rule.path.toLowerCase()}/`
    if (!lower.startsWith(prefix)) continue
    const access = ruleAccess(rule)
    const rankDiff = ACCESS_RANK[access] - ACCESS_RANK[inheritedAccess]
    if (
      coveredByParent === null ||
      rankDiff > 0 ||
      (rankDiff === 0 && coveredByParent !== DRIVE_ROOT_RULE_PATH && rule.path.length > coveredByParent.length)
    ) {
      coveredByParent = rule.path
      inheritedAccess = access
    }
  }
  return { coveredByParent, inheritedAccess }
}

function parentTagCover(
  tag: string,
  rules: readonly LlmExclusion[],
): { coveredByParent: string | null; inheritedAccess: RuleAccess } {
  return parentCover(tag, rules)
}

function directDirname(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? '' : filePath.slice(0, slash)
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}

export interface ObsidianFolderRow {
  path: string
  documents: number | null
  locked: boolean
  access: RuleAccess
  inheritedAccess: RuleAccess
  coveredByParent: string | null
  inCatalog: boolean
}

export interface ObsidianTagRow {
  tag: string
  documents: number | null
  locked: boolean
  access: RuleAccess
  inheritedAccess: RuleAccess
  coveredByParent: string | null
  inCatalog: boolean
}

export interface ObsidianNoteRow {
  path: string
  locked: boolean
  access: RuleAccess
  inheritedAccess: RuleAccess
  coveredByFolder: string | null
  inCatalog: boolean
}

export interface ObsidianCatalogView {
  lockedCount: number
  folders: ObsidianFolderRow[]
  tags: ObsidianTagRow[]
  notes: ObsidianNoteRow[]
}

export function buildObsidianView(
  obsidian: LlmExclusionCatalog['obsidian'],
  list: readonly CountedLlmExclusion[],
  released: readonly CountedLlmExclusion[],
): ObsidianCatalogView {
  const lockedFolders = list.filter((r) => r.kind === 'folder')
  const lockedTags = list.filter((r) => r.kind === 'tag')
  const lockedNotes = list.filter((r) => r.kind === 'note')

  const folderMap = new Map<string, ObsidianFolderRow>()
  for (const item of obsidian.folders) {
    const rule = lockedFolders.find((r) => r.path.toLowerCase() === item.path.toLowerCase())
    const cover = parentCover(item.path, lockedFolders)
    folderMap.set(item.path.toLowerCase(), {
      path: rule?.path ?? item.path,
      documents: rule?.documents ?? item.documents,
      locked: rule !== undefined,
      access: strictestAccess(ruleAccess(rule), cover.inheritedAccess),
      inheritedAccess: cover.inheritedAccess,
      coveredByParent: cover.coveredByParent,
      inCatalog: true,
    })
  }
  for (const rule of [...released.filter((r) => r.kind === 'folder'), ...lockedFolders]) {
    const key = rule.path.toLowerCase()
    const active = lockedFolders.find((r) => r.path.toLowerCase() === key)
    if (!folderMap.has(key)) {
      const cover = parentCover(rule.path, lockedFolders)
      folderMap.set(key, {
        path: rule.path,
        documents: rule.documents,
        locked: active !== undefined,
        access: strictestAccess(ruleAccess(active), cover.inheritedAccess),
        inheritedAccess: cover.inheritedAccess,
        coveredByParent: cover.coveredByParent,
        inCatalog: false,
      })
    }
  }

  const tagMap = new Map<string, ObsidianTagRow>()
  for (const item of obsidian.tags) {
    const rule = lockedTags.find((r) => r.path.toLowerCase() === item.tag.toLowerCase())
    const cover = parentTagCover(item.tag, lockedTags)
    tagMap.set(item.tag.toLowerCase(), {
      tag: rule?.path ?? item.tag,
      documents: rule?.documents ?? item.documents,
      locked: rule !== undefined,
      access: strictestAccess(ruleAccess(rule), cover.inheritedAccess),
      inheritedAccess: cover.inheritedAccess,
      coveredByParent: cover.coveredByParent,
      inCatalog: true,
    })
  }
  for (const rule of [...released.filter((r) => r.kind === 'tag'), ...lockedTags]) {
    const key = rule.path.toLowerCase()
    const active = lockedTags.find((r) => r.path.toLowerCase() === key)
    if (!tagMap.has(key)) {
      const cover = parentTagCover(rule.path, lockedTags)
      tagMap.set(key, {
        tag: rule.path,
        documents: rule.documents,
        locked: active !== undefined,
        access: strictestAccess(ruleAccess(active), cover.inheritedAccess),
        inheritedAccess: cover.inheritedAccess,
        coveredByParent: cover.coveredByParent,
        inCatalog: false,
      })
    }
  }

  const noteMap = new Map<string, ObsidianNoteRow>()
  for (const path of obsidian.notes) {
    const rule = lockedNotes.find((r) => r.path.toLowerCase() === path.toLowerCase())
    const cover = parentCover(path, lockedFolders)
    noteMap.set(path.toLowerCase(), {
      path: rule?.path ?? path,
      locked: rule !== undefined,
      access: strictestAccess(ruleAccess(rule), cover.inheritedAccess),
      inheritedAccess: cover.inheritedAccess,
      coveredByFolder: cover.coveredByParent,
      inCatalog: true,
    })
  }
  for (const rule of [...released.filter((r) => r.kind === 'note'), ...lockedNotes]) {
    const key = rule.path.toLowerCase()
    const active = lockedNotes.find((r) => r.path.toLowerCase() === key)
    if (!noteMap.has(key)) {
      const cover = parentCover(rule.path, lockedFolders)
      noteMap.set(key, {
        path: rule.path,
        locked: active !== undefined,
        access: strictestAccess(ruleAccess(active), cover.inheritedAccess),
        inheritedAccess: cover.inheritedAccess,
        coveredByFolder: cover.coveredByParent,
        inCatalog: false,
      })
    }
  }

  return {
    lockedCount: lockedFolders.length + lockedTags.length + lockedNotes.length,
    folders: [...folderMap.values()].sort((a, b) => compareIgnoreCase(a.path, b.path)),
    tags: [...tagMap.values()].sort((a, b) => compareIgnoreCase(a.tag, b.tag)),
    notes: [...noteMap.values()].sort((a, b) => compareIgnoreCase(a.path, b.path)),
  }
}

export interface RepoRuleRow {
  name: string
  files: number
  locked: boolean
  access: RuleAccess
  inIndex: boolean
}

export function buildRepoRows(
  repos: readonly RepoInfo[] | null,
  list: readonly CountedLlmExclusion[],
  released: readonly CountedLlmExclusion[],
): RepoRuleRow[] {
  const lockedRepos = list.filter((r) => r.kind === 'repo')
  const map = new Map<string, RepoRuleRow>()
  for (const repo of repos ?? []) {
    const rule = lockedRepos.find((r) => r.path.toLowerCase() === repo.name.toLowerCase())
    map.set(repo.name.toLowerCase(), {
      name: repo.name,
      files: repo.files,
      locked: rule !== undefined,
      access: ruleAccess(rule),
      inIndex: true,
    })
  }
  for (const rule of [...released.filter((r) => r.kind === 'repo'), ...lockedRepos]) {
    const key = rule.path.toLowerCase()
    const active = lockedRepos.find((r) => r.path.toLowerCase() === key)
    if (!map.has(key)) {
      map.set(key, {
        name: rule.path,
        files: rule.documents,
        locked: active !== undefined,
        access: ruleAccess(active),
        inIndex: false,
      })
    }
  }
  return [...map.values()].sort((a, b) => compareIgnoreCase(a.name, b.name))
}

export interface DriveFolderRow {
  path: string
  documents: number | null
  files: { path: string; name: string }[]
  locked: boolean
  access: RuleAccess
  inheritedAccess: RuleAccess
  coveredByParent: string | null
  inCatalog: boolean
}

export interface DriveFolderNode {
  folder: DriveFolderRow
  name: string
  children: DriveFolderNode[]
}

export interface DriveCatalogView {
  allLocked: boolean
  allAccess: RuleAccess
  allDocuments: number
  lockedFolderCount: number
  folders: DriveFolderRow[]
  folderTree: DriveFolderNode[]
  rootFiles: { path: string; name: string }[]
}

/** Nests sorted Drive folder rows under their nearest present ancestor folder. */
export function buildDriveFolderTree(folders: readonly DriveFolderRow[]): DriveFolderNode[] {
  const roots: DriveFolderNode[] = []
  const byPath = new Map<string, DriveFolderNode>()
  for (const folder of folders) {
    const node: DriveFolderNode = { folder, name: folder.path, children: [] }
    byPath.set(folder.path.toLowerCase(), node)
    const parts = folder.path.split('/')
    let parent: DriveFolderNode | undefined
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = byPath.get(parts.slice(0, i).join('/').toLowerCase())
      if (candidate !== undefined) {
        parent = candidate
        break
      }
    }
    if (parent !== undefined) {
      node.name = folder.path.slice(parent.folder.path.length + 1)
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

export function buildDriveView(
  gdrive: LlmExclusionCatalog['gdrive'],
  list: readonly CountedLlmExclusion[],
  released: readonly CountedLlmExclusion[],
): DriveCatalogView {
  const driveRules = list.filter((r) => r.kind === 'gdrive')
  const rootRule = driveRules.find((r) => r.path === DRIVE_ROOT_RULE_PATH)
  const allLocked = rootRule !== undefined
  const allAccess = ruleAccess(rootRule)
  const folderRules = driveRules.filter((r) => r.path !== DRIVE_ROOT_RULE_PATH)

  const filesByDir = new Map<string, { path: string; name: string }[]>()
  for (const filePath of gdrive.files) {
    const dir = directDirname(filePath).toLowerCase()
    const bucket = filesByDir.get(dir) ?? []
    bucket.push({ path: filePath, name: baseName(filePath) })
    filesByDir.set(dir, bucket)
  }

  const folderMap = new Map<string, DriveFolderRow>()
  for (const item of gdrive.folders) {
    const key = item.path.toLowerCase()
    const rule = folderRules.find((r) => r.path.toLowerCase() === key)
    const cover = parentCover(item.path, folderRules, rootRule)
    folderMap.set(key, {
      path: rule?.path ?? item.path,
      documents: rule?.documents ?? item.documents,
      files: filesByDir.get(key) ?? [],
      locked: rule !== undefined,
      access: strictestAccess(ruleAccess(rule), cover.inheritedAccess),
      inheritedAccess: cover.inheritedAccess,
      coveredByParent: cover.coveredByParent,
      inCatalog: true,
    })
  }
  for (const rule of [
    ...released.filter((r) => r.kind === 'gdrive' && r.path !== DRIVE_ROOT_RULE_PATH),
    ...folderRules,
  ]) {
    const key = rule.path.toLowerCase()
    const active = folderRules.find((r) => r.path.toLowerCase() === key)
    if (!folderMap.has(key)) {
      const cover = parentCover(rule.path, folderRules, rootRule)
      folderMap.set(key, {
        path: rule.path,
        documents: rule.documents,
        files: filesByDir.get(key) ?? [],
        locked: active !== undefined,
        access: strictestAccess(ruleAccess(active), cover.inheritedAccess),
        inheritedAccess: cover.inheritedAccess,
        coveredByParent: cover.coveredByParent,
        inCatalog: false,
      })
    }
  }

  const folders = [...folderMap.values()].sort((a, b) => compareIgnoreCase(a.path, b.path))
  return {
    allLocked,
    allAccess,
    allDocuments: rootRule?.documents ?? gdrive.totalDocuments,
    lockedFolderCount: folderRules.length,
    folders,
    folderTree: buildDriveFolderTree(folders),
    rootFiles: filesByDir.get('') ?? [],
  }
}

export function buildKeepRow(
  keep: LlmExclusionCatalog['keep'],
  list: readonly CountedLlmExclusion[],
): { locked: boolean; access: RuleAccess; documents: number } {
  const rule = list.find((r) => r.kind === 'keep')
  return {
    locked: rule !== undefined,
    access: ruleAccess(rule),
    documents: rule?.documents ?? keep.documents,
  }
}

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

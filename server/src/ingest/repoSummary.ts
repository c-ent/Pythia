import path from 'node:path'

/**
 * Builds the one deterministic `SUMMARY` chunk per repo (R9) from its
 * README, file tree and dependency manifests, without an LLM. The same
 * inputs always give the same text, so an unchanged repo keeps its hash and
 * is never re-embedded.
 */

export const SUMMARY_HEADING = 'SUMMARY'
export const MAX_SUMMARY_CHARS = 6000
const README_CHARS = 1500
const TREE_ENTRIES = 40
const DEPENDENCY_NAMES = 40

export interface RepoSummaryInput {
  repo: string
  branch: string | null
  /** Earliest commit timestamp in the repo's history. */
  firstCommitAt?: Date | null
  /** Latest commit timestamp on the indexed branch. */
  lastCommitAt?: Date | null
  /** Paths of the files selected for indexing, repo-relative. */
  files: ReadonlyArray<{ path: string; language: string | null }>
  /** Root README text, if any. */
  readme?: string | null
  /** Manifest files by repo-relative path, e.g. `package.json`. */
  manifests?: Readonly<Record<string, string>>
}

export interface SummaryChunk {
  ordinal: 0
  headingPath: string
  startLine: 1
  endLine: 1
  content: string
  embedText: string
}

const byKey = <T>(entries: Iterable<[string, T]>): Array<[string, T]> =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

/** First paragraphs of the README, without badges, HTML and front matter. */
export function readmeExcerpt(text: string): string {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (cleaned.length <= README_CHARS) return cleaned
  const cut = cleaned.slice(0, README_CHARS)
  const lastBreak = cut.lastIndexOf('\n\n')
  return `${(lastBreak > README_CHARS / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()} …`
}

/** Top-level folders with file counts, then root files, capped. */
export function treeOverview(files: RepoSummaryInput['files']): string[] {
  const folders = new Map<string, number>()
  const rootFiles: string[] = []
  for (const file of files) {
    const slash = file.path.indexOf('/')
    if (slash === -1) rootFiles.push(file.path)
    else folders.set(file.path.slice(0, slash), (folders.get(file.path.slice(0, slash)) ?? 0) + 1)
  }
  const lines = [
    ...byKey(folders).map(([folder, count]) => `${folder}/ (${count} file${count === 1 ? '' : 's'})`),
    ...rootFiles.sort(),
  ]
  return lines.length > TREE_ENTRIES ? [...lines.slice(0, TREE_ENTRIES), `… ${lines.length - TREE_ENTRIES} more`] : lines
}

/** Languages by file count, most first, ties by name. */
export function languageCounts(files: RepoSummaryInput['files']): string[] {
  const counts = new Map<string, number>()
  for (const file of files) if (file.language !== null) counts.set(file.language, (counts.get(file.language) ?? 0) + 1)
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .map(([language, count]) => `${language} (${count})`)
}

const names = (value: unknown): string[] =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : []

const capped = (list: string[]): string =>
  list.length > DEPENDENCY_NAMES ? `${list.slice(0, DEPENDENCY_NAMES).join(', ')}, … ${list.length - DEPENDENCY_NAMES} more` : list.join(', ')

/**
 * Dependency names from one manifest. Only names, never versions or
 * scripts: scripts can hold paths and commands that are noise for search.
 */
export function manifestLines(file: string, text: string): string[] {
  const base = path.posix.basename(file).toLowerCase()
  const lines: string[] = []
  if (base === 'package.json' || base === 'composer.json') {
    let json: Record<string, unknown>
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>
    } catch {
      return [`${file}: not valid JSON`]
    }
    if (typeof json.name === 'string') lines.push(`${file} name: ${json.name}`)
    if (typeof json.description === 'string') lines.push(`${file} description: ${json.description.slice(0, 200)}`)
    const runtime = base === 'package.json' ? names(json.dependencies) : names(json.require)
    const dev = base === 'package.json' ? names(json.devDependencies) : names(json['require-dev'])
    if (runtime.length > 0) lines.push(`${file} dependencies: ${capped(runtime)}`)
    if (dev.length > 0) lines.push(`${file} dev dependencies: ${capped(dev)}`)
    return lines
  }
  if (/^requirements(?:[-_.][a-z0-9_.-]*)?\.txt$/.test(base)) {
    const packages = text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter((line) => line !== '' && !line.startsWith('-'))
      .map((line) => line.split(/[\s<>=!~;[@]/)[0] ?? '')
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    const unique = [...new Set(packages.map((name) => name.toLowerCase()))].sort()
    return unique.length > 0 ? [`${file} packages: ${capped(unique)}`] : []
  }
  return [`${file}`]
}

const formatCommitIso = (date: Date | null | undefined): string | null =>
  date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null

/** The repo's `SUMMARY` chunk. Deterministic: inputs are sorted before use. */
export function buildRepoSummary(input: RepoSummaryInput): SummaryChunk {
  const header = [`Repository: ${input.repo}${input.branch === null ? '' : ` (branch ${input.branch})`}`]
  const firstCommit = formatCommitIso(input.firstCommitAt)
  if (firstCommit !== null) header.push(`First commit: ${firstCommit}`)
  const lastCommit = formatCommitIso(input.lastCommitAt)
  if (lastCommit !== null) header.push(`Latest commit: ${lastCommit}`)

  const sections: string[] = [header.join('\n')]
  sections.push(`Indexed files: ${input.files.length}`)
  const languages = languageCounts(input.files)
  if (languages.length > 0) sections.push(`Languages: ${languages.join(', ')}`)

  const readme = input.readme?.trim() ? readmeExcerpt(input.readme) : ''
  if (readme !== '') sections.push(`README:\n${readme}`)

  const manifests = byKey(Object.entries(input.manifests ?? {})).flatMap(([file, text]) => manifestLines(file, text))
  if (manifests.length > 0) sections.push(`Dependencies:\n${manifests.join('\n')}`)

  const tree = treeOverview(input.files)
  if (tree.length > 0) sections.push(`Files:\n${tree.join('\n')}`)

  let content = sections.join('\n\n')
  if (content.length > MAX_SUMMARY_CHARS) content = `${content.slice(0, MAX_SUMMARY_CHARS - 2).trimEnd()} …`
  const headingPath = `${SUMMARY_HEADING} > ${input.repo}`
  return { ordinal: 0, headingPath, startLine: 1, endLine: 1, content, embedText: `${headingPath}\n\n${content}` }
}

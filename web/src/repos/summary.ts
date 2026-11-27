/**
 * Reads the parts the Repos page shows (T44) out of a repo's `SUMMARY` text,
 * which the server builds deterministically (server/src/ingest/repoSummary.ts):
 *
 *   Repository: <name> (branch <branch>)
 *   Indexed files: <n>
 *   Languages: typescript (12), css (2)
 *   README:\n<excerpt>
 *   Dependencies:\n<lines>
 *   Files:\n<folder>/ (<n> files)\n<root file>\n… <n> more
 *
 * Sections are separated by a blank line. Anything missing reads as empty.
 */

/** Display names for the language ids the repo indexer uses (server/src/ingest/repoFilter.ts). */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  php: 'PHP',
  ruby: 'Ruby',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  kotlin: 'Kotlin',
  scala: 'Scala',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  fsharp: 'F#',
  bash: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  lua: 'Lua',
  dart: 'Dart',
  elixir: 'Elixir',
  erlang: 'Erlang',
  haskell: 'Haskell',
  clojure: 'Clojure',
  r: 'R',
  julia: 'Julia',
  ocaml: 'OCaml',
  zig: 'Zig',
  nix: 'Nix',
  terraform: 'Terraform',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  graphql: 'GraphQL',
  protobuf: 'Protobuf',
  dockerfile: 'Dockerfile',
  make: 'Makefile',
  groovy: 'Groovy',
}

/** READMEs and manifests carry these; they say nothing about what the code is written in. */
const NOT_CODE = new Set(['markdown', 'json', 'toml', 'yaml', 'ini', 'xml'])

const DESCRIPTION_CHARS = 180

export function languageName(id: string): string {
  return LANGUAGE_NAMES[id] ?? (id === '' ? id : id.charAt(0).toUpperCase() + id.slice(1))
}

export interface LanguageShare {
  name: string
  files: number
  /** Rounded share of the code files, 0 to 100. */
  percent: number
}

export interface TreeEntry {
  /** A top-level folder with its trailing `/`, or a root file. */
  name: string
  /** Files in the folder; null for a root file. */
  files: number | null
}

export interface RepoSummaryParts {
  branch: string | null
  /** Code languages by file count, most first; `tsx` counts as TypeScript. */
  languages: LanguageShare[]
  /** The README's first paragraph of prose, shortened. */
  description: string | null
  tree: TreeEntry[]
  /** Entries the server left out of the tree ("… 12 more"). */
  moreEntries: number
}

const SECTION = /\n\n(?=Indexed files: |Languages: |README:\n|Dependencies:\n|Files:\n)/

export function parseLanguages(line: string): LanguageShare[] {
  const counts = new Map<string, number>()
  for (const match of line.matchAll(/([^,()]+?) \((\d+)\)/g)) {
    const id = (match[1] ?? '').trim().toLowerCase()
    if (id === '' || NOT_CODE.has(id)) continue
    const name = languageName(id)
    counts.set(name, (counts.get(name) ?? 0) + Number(match[2]))
  }
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
  return [...counts]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, files]) => ({ name, files, percent: total === 0 ? 0 : Math.round((files / total) * 100) }))
}

const cleanInline = (text: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The first paragraph that is prose: not a heading, rule, list of badges, code fence or table. */
export function readmeDescription(readme: string): string | null {
  for (const paragraph of readme.split(/\n{2,}/)) {
    const lines = paragraph.split('\n')
    // A Setext heading ("Title" over "====") is a heading, not prose.
    if (lines.some((line) => /^\s*[=-]{3,}\s*$/.test(line))) continue
    const prose = lines.filter((line) => !/^\s*(#{1,6}\s|```|~~~|\||>\s*$)/.test(line))
    const text = cleanInline(prose.join(' '))
    if (text === '' || text === '…') continue
    return text.length > DESCRIPTION_CHARS ? `${text.slice(0, DESCRIPTION_CHARS - 1).trimEnd()}…` : text
  }
  return null
}

function parseTree(lines: string[]): { tree: TreeEntry[]; moreEntries: number } {
  const tree: TreeEntry[] = []
  let moreEntries = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    const more = /^… (\d+) more$/.exec(line)
    if (more !== null) {
      moreEntries = Number(more[1])
      continue
    }
    // The server shortens a long summary with " …"; that last line is cut off.
    if (line.endsWith(' …')) continue
    const folder = /^(.+\/) \((\d+) files?\)$/.exec(line)
    if (folder !== null) tree.push({ name: folder[1] ?? line, files: Number(folder[2]) })
    else tree.push({ name: line, files: null })
  }
  return { tree, moreEntries }
}

export function parseRepoSummary(text: string): RepoSummaryParts {
  const parts: RepoSummaryParts = { branch: null, languages: [], description: null, tree: [], moreEntries: 0 }
  for (const section of text.replace(/\r\n/g, '\n').split(SECTION)) {
    if (section.startsWith('Repository: ')) {
      parts.branch = /\(branch ([^)]+)\)\s*$/.exec(section.split('\n')[0] ?? '')?.[1] ?? null
    } else if (section.startsWith('Languages: ')) {
      parts.languages = parseLanguages(section.slice('Languages: '.length))
    } else if (section.startsWith('README:\n')) {
      parts.description = readmeDescription(section.slice('README:\n'.length))
    } else if (section.startsWith('Files:\n')) {
      Object.assign(parts, parseTree(section.slice('Files:\n'.length).split('\n')))
    }
  }
  return parts
}

/** Two letters for the repo's tile: "kitchen-app" gives "Ki". */
export function repoInitials(name: string): string {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, '')
  if (letters === '') return '?'
  return letters.charAt(0).toUpperCase() + letters.slice(1, 2)
}

import ignore, { type Ignore } from 'ignore'
import { isBlockedPath } from '../security/secrets.js'

/**
 * Which files of a repo get indexed (R9): source code, READMEs and package
 * manifests, nothing else. Paths are repo-relative with `/` separators, as
 * `git ls-tree` prints them. Everything here is pure; reading the tree and
 * the `.gitignore` files is the caller's job.
 */

export const MAX_REPO_FILE_BYTES = 200 * 1024

export type RepoFileKind = 'code' | 'readme' | 'manifest'

export type SkipReason =
  | 'blocked'
  | 'ignored-directory'
  | 'gitignore'
  | 'lockfile'
  | 'minified'
  | 'not-allowlisted'
  | 'too-large'
  | 'binary'

export type PathDecision =
  | { index: true; kind: RepoFileKind; language: string | null }
  | { index: false; reason: SkipReason }

/** Build output, dependencies and caches, at any depth. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'bower_components',
  'jspm_packages',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
])

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'poetry.lock',
  'pdm.lock',
  'uv.lock',
  'pipfile.lock',
  'gemfile.lock',
  'cargo.lock',
  'go.sum',
  'mix.lock',
  'pubspec.lock',
  'podfile.lock',
  'flake.lock',
  'packages.lock.json',
])

/** Dependency manifests, by lower-case file name, with their language. */
const MANIFESTS = new Map<string, string | null>([
  ['package.json', 'json'],
  ['composer.json', 'json'],
  ['deno.json', 'json'],
  ['pyproject.toml', 'toml'],
  ['pipfile', 'toml'],
  ['setup.cfg', 'ini'],
  ['cargo.toml', 'toml'],
  ['go.mod', null],
  ['gemfile', 'ruby'],
  ['pom.xml', 'xml'],
  ['build.gradle', 'groovy'],
  ['build.gradle.kts', 'kotlin'],
  ['pubspec.yaml', 'yaml'],
  ['mix.exs', 'elixir'],
])
const REQUIREMENTS = /^requirements(?:[-_.][a-z0-9_.-]*)?\.txt$/

const README = /^readme(?:\.(md|markdown|mdx|rst|txt|adoc|org))?$/

/** Source files by lower-case extension, with the language name the chunker (T16) uses. */
const CODE_EXTENSIONS = new Map<string, string>([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'javascript'],
  ['py', 'python'],
  ['pyi', 'python'],
  ['php', 'php'],
  ['rb', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['scala', 'scala'],
  ['swift', 'swift'],
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['cs', 'csharp'],
  ['fs', 'fsharp'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['sql', 'sql'],
  ['lua', 'lua'],
  ['dart', 'dart'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['erl', 'erlang'],
  ['hs', 'haskell'],
  ['clj', 'clojure'],
  ['r', 'r'],
  ['jl', 'julia'],
  ['ml', 'ocaml'],
  ['zig', 'zig'],
  ['nix', 'nix'],
  ['tf', 'terraform'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['astro', 'astro'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['graphql', 'graphql'],
  ['gql', 'graphql'],
  ['proto', 'protobuf'],
])

/** Extension-less build files that read as code. */
const CODE_FILE_NAMES = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'make'],
])

const MINIFIED = /(?:[.-]min\.(?:js|mjs|cjs|css)|\.(?:js|css)\.map|\.map)$/

/** Classifies one tracked file by path and size, ignoring `.gitignore`. */
export function classifyRepoPath(filePath: string, size: number): PathDecision {
  if (isBlockedPath(filePath)) return { index: false, reason: 'blocked' }

  const segments = filePath.split('/')
  const fileName = (segments.at(-1) ?? '').toLowerCase()
  if (segments.slice(0, -1).some((segment) => IGNORED_DIRECTORIES.has(segment.toLowerCase()))) {
    return { index: false, reason: 'ignored-directory' }
  }
  if (LOCKFILES.has(fileName)) return { index: false, reason: 'lockfile' }
  if (MINIFIED.test(fileName)) return { index: false, reason: 'minified' }

  const decision = allowlisted(fileName)
  if (decision === null) return { index: false, reason: 'not-allowlisted' }
  if (size > MAX_REPO_FILE_BYTES) return { index: false, reason: 'too-large' }
  return decision
}

function allowlisted(fileName: string): Extract<PathDecision, { index: true }> | null {
  const readme = README.exec(fileName)
  if (readme !== null) {
    const ext = readme[1]
    const markdown = ext === undefined || ext === 'md' || ext === 'markdown' || ext === 'mdx'
    return { index: true, kind: 'readme', language: markdown ? 'markdown' : null }
  }
  if (MANIFESTS.has(fileName)) return { index: true, kind: 'manifest', language: MANIFESTS.get(fileName) ?? null }
  if (REQUIREMENTS.test(fileName)) return { index: true, kind: 'manifest', language: null }

  const named = CODE_FILE_NAMES.get(fileName)
  if (named !== undefined) return { index: true, kind: 'code', language: named }
  const dot = fileName.lastIndexOf('.')
  // A leading dot is a hidden file (`.eslintrc`), not an extension.
  if (dot <= 0) return null
  const language = CODE_EXTENSIONS.get(fileName.slice(dot + 1))
  return language === undefined ? null : { index: true, kind: 'code', language }
}

export interface GitignoreFile {
  /** Directory holding the `.gitignore`, repo-relative; `''` for the root. */
  dir: string
  text: string
}

/**
 * Matches paths the way git applies a tree of `.gitignore` files: each
 * file's patterns are relative to its own directory, and a deeper file can
 * re-include (`!pattern`) what a shallower one excluded.
 */
export function createGitignoreMatcher(files: readonly GitignoreFile[]): (filePath: string) => boolean {
  const layers: Array<{ dir: string; rules: Ignore }> = files
    .map((file) => ({ dir: file.dir.replace(/^\/+|\/+$/g, ''), rules: ignore().add(file.text) }))
    .sort((a, b) => depth(a.dir) - depth(b.dir))

  return (filePath) => {
    let ignored = false
    for (const { dir, rules } of layers) {
      if (dir !== '' && !filePath.startsWith(`${dir}/`)) continue
      const relative = dir === '' ? filePath : filePath.slice(dir.length + 1)
      const result = rules.test(relative)
      if (result.ignored) ignored = true
      else if (result.unignored) ignored = false
    }
    return ignored
  }
}

const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length)

export interface RepoTreeFile {
  path: string
  size: number
}

export type IncludedRepoFile<T extends RepoTreeFile> = T & { kind: RepoFileKind; language: string | null }

export interface RepoFileSelection<T extends RepoTreeFile> {
  included: Array<IncludedRepoFile<T>>
  /** How many files each rule skipped; counts only, never paths of private files. */
  skipped: Record<SkipReason, number>
}

const emptyCounts = (): Record<SkipReason, number> => ({
  blocked: 0,
  'ignored-directory': 0,
  gitignore: 0,
  lockfile: 0,
  minified: 0,
  'not-allowlisted': 0,
  'too-large': 0,
  binary: 0,
})

/** Applies the secrets blocklist, `.gitignore`, the directory and lockfile rules, the allowlist and the size cap. */
export function selectRepoFiles<T extends RepoTreeFile>(
  files: readonly T[],
  gitignores: readonly GitignoreFile[] = [],
): RepoFileSelection<T> {
  const isIgnored = createGitignoreMatcher(gitignores)
  const skipped = emptyCounts()
  const included: Array<IncludedRepoFile<T>> = []
  for (const file of files) {
    // The blocklist wins over everything, so it is counted first.
    const decision = isBlockedPath(file.path)
      ? ({ index: false, reason: 'blocked' } as const)
      : isIgnored(file.path)
        ? ({ index: false, reason: 'gitignore' } as const)
        : classifyRepoPath(file.path, file.size)
    if (decision.index) included.push({ ...file, kind: decision.kind, language: decision.language })
    else skipped[decision.reason] += 1
  }
  return { included, skipped }
}

/**
 * Git's own heuristic: a NUL byte in the first 8000 bytes means binary.
 * Run on file content before chunking, since an allowlisted extension can
 * still hold binary data.
 */
export function looksBinary(content: Uint8Array): boolean {
  const end = Math.min(content.length, 8000)
  for (let i = 0; i < end; i += 1) if (content[i] === 0) return true
  return false
}

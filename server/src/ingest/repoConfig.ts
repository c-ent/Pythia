import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

/**
 * The list of personal GitHub repos to index (R9), read from a JSON file:
 *
 *   { "repos": [ { "name": "kitchen-app", "url": "https://github.com/me/kitchen-app.git", "branch": "main" } ] }
 *
 * Every entry becomes a `kind = 'repo'` source. The schema is strict, so a
 * stray `kind` key (or any typo) is rejected instead of silently ignored:
 * this file can never add a `work` source.
 */

export interface RepoSpec {
  /** Source name: the repo filter value, the MCP `repo` argument and the mirror directory name. */
  name: string
  url: string
  /** Null means the remote's default branch. */
  branch: string | null
}

export class RepoConfigError extends Error {
  override name = 'RepoConfigError'
}

export const MAX_REPOS = 200
export const REPO_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

// A git ref name, restricted further than git itself: no leading `-` (it
// would read as an option), no `..`, no trailing `/` or `.lock`.
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/

/**
 * Remotes git may fetch from: `https://` and `ssh://` without a password in
 * the URL, scp-style `git@host:owner/repo.git` (deploy keys), `file://`, or an
 * absolute local path. Plain `http://` and the `ext::` and `fd::` transports
 * (which run commands) are refused, and so is anything starting with `-`.
 */
export function isAllowedRemote(url: string): boolean {
  if (url.startsWith('-') || /\s/.test(url) || url.includes('::')) return false
  if (/^(https|ssh):\/\//i.test(url)) {
    try {
      const parsed = new URL(url)
      if (parsed.hostname === '' || parsed.password !== '') return false
      // A user name in an https URL is usually a token pasted in by mistake.
      return parsed.protocol === 'ssh:' || parsed.username === ''
    } catch {
      return false
    }
  }
  if (/^file:\/\//i.test(url)) return true
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^/\\:]/.test(url)) return true
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false
  return path.isAbsolute(url)
}

const repoSchema = z
  .object({
    name: z
      .string()
      .regex(REPO_NAME_PATTERN, 'must be 1–100 letters, digits, ".", "_" or "-", starting with a letter or digit')
      .refine((name) => !name.toLowerCase().endsWith('.git'), 'must not end in .git'),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(
        isAllowedRemote,
        'must be an https://, ssh:// or git@host: URL without credentials, or an absolute local path',
      ),
    branch: z
      .string()
      .trim()
      .regex(BRANCH_PATTERN, 'is not a valid branch name')
      .refine((branch) => !branch.endsWith('/') && !branch.endsWith('.lock'), 'is not a valid branch name')
      .optional(),
    enabled: z.boolean().default(true),
  })
  .strict()

const fileSchema = z
  .object({ repos: z.array(repoSchema).max(MAX_REPOS) })
  .strict()
  .superRefine((file, ctx) => {
    // Case-insensitive: mirrors are directories, and Windows and macOS
    // filesystems treat `App` and `app` as the same name.
    const seen = new Set<string>()
    file.repos.forEach((repo, i) => {
      const key = repo.name.toLowerCase()
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['repos', i, 'name'], message: 'is used by another repo' })
      seen.add(key)
    })
  })

/** Validates a parsed config file and returns the enabled repos. */
export function parseRepoConfig(value: unknown): RepoSpec[] {
  const result = fileSchema.safeParse(value)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const where = issue.path.join('.')
      return where === '' ? issue.message : `${where} ${issue.message}`
    })
    throw new RepoConfigError(`Invalid repo config: ${problems.join('; ')}`)
  }
  return result.data.repos
    .filter((repo) => repo.enabled)
    .map((repo) => ({ name: repo.name, url: repo.url, branch: repo.branch ?? null }))
}

export async function loadRepoConfig(file: string): Promise<RepoSpec[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read error'
    throw new RepoConfigError(`Cannot read the repo config file (${code})`)
  }
  let value: unknown
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new RepoConfigError('The repo config file is not valid JSON')
  }
  return parseRepoConfig(value)
}

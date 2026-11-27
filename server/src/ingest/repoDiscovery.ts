import { z } from 'zod'
import { isAllowedRemote, MAX_REPOS, REPO_NAME_PATTERN, type RepoSpec } from './repoConfig.js'

/**
 * Repo discovery (R9, T54). With `PYTHIA_REPOS_DISCOVER=1`, each repo round
 * first lists the token owner's GitHub repos (forks and private ones included)
 * and adds any that are not configured yet, so a new repo is cloned and
 * indexed without editing the config or restarting.
 *
 * - Only adds: a repo deleted or renamed on GitHub keeps its index until it is
 *   removed from the config by hand.
 * - Never adds a repo named in the config (disabled ones included) or in its
 *   `exclude` list. Names are lowercased, like the owner's generated list, so
 *   an existing repo is never added twice under another case.
 * - A failed or rate-limited listing keeps the current list; the next round tries again.
 * - The token goes in the request header only. Logs carry repo names, counts
 *   and error classes, never the token, URLs with credentials or response bodies.
 * - Discovered repos are `kind = 'repo'` like every configured one; nothing here can add `work`.
 */

export const GITHUB_API_URL = 'https://api.github.com'
const PER_PAGE = 100
// 10 pages of 100 is far past MAX_REPOS; the cap stops a runaway listing.
const MAX_PAGES = 10
const GITHUB_CLONE_PREFIX = 'https://github.com/'

export class RepoDiscoveryError extends Error {
  override name = 'RepoDiscoveryError'
}

export interface OwnedRepo {
  name: string
  url: string
}

export interface ListOwnedReposOptions {
  token: string
  /** Injected for tests. */
  fetch?: typeof fetch
  apiUrl?: string
  timeoutMs?: number
}

// Only the two fields used; the rest of GitHub's repo object is ignored.
const pageSchema = z.array(z.object({ name: z.string(), clone_url: z.string() }))

const errorName = (error: unknown): string => (error instanceof Error && error.name !== '' ? error.name : 'unknown')

/** `GET /user/repos?affiliation=owner`, every page. Throws `RepoDiscoveryError` with a short reason. */
export async function listOwnedRepos(options: ListOwnedReposOptions): Promise<OwnedRepo[]> {
  const fetchFn = options.fetch ?? fetch
  const apiUrl = options.apiUrl ?? GITHUB_API_URL
  const repos: OwnedRepo[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let res: Response
    try {
      res = await fetchFn(`${apiUrl}/user/repos?affiliation=owner&per_page=${PER_PAGE}&page=${page}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'User-Agent': 'pythia',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      })
    } catch (error) {
      throw new RepoDiscoveryError(`GitHub request failed: ${errorName(error)}`)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
      throw new RepoDiscoveryError(limited ? 'GitHub rate limit reached' : `GitHub answered ${res.status}`)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new RepoDiscoveryError('GitHub answered with invalid JSON')
    }
    const parsed = pageSchema.safeParse(body)
    if (!parsed.success) throw new RepoDiscoveryError('GitHub answered with an unexpected repo list')
    for (const repo of parsed.data) repos.push({ name: repo.name, url: repo.clone_url })
    if (parsed.data.length < PER_PAGE) break
  }
  return repos
}

export interface RepoDiscoveryOptions {
  /** Lists the owner's repos; `listOwnedRepos` in the server. */
  list: () => Promise<OwnedRepo[]>
  /** Every repo name in the config file, disabled ones too, lowercased. */
  configured: readonly string[]
  /** The config's `exclude` list, lowercased. */
  exclude: readonly string[]
  log?: (message: string) => void
  /** Failures, by error class only. */
  warn?: (message: string) => void
}

/** Returns the repos to add to `current`; an empty list when nothing is new or the listing failed. */
export type RepoDiscover = (current: readonly RepoSpec[]) => Promise<RepoSpec[]>

export function createRepoDiscovery(options: RepoDiscoveryOptions): RepoDiscover {
  const log = options.log ?? ((message: string) => console.log(message))
  const warn = options.warn ?? ((message: string) => console.error(message))
  const never = new Set([...options.configured, ...options.exclude].map((name) => name.toLowerCase()))
  // Report an unusable repo or the limit once, not every 30 minutes.
  const reported = new Set<string>()
  const once = (key: string, message: string) => {
    if (reported.has(key)) return
    reported.add(key)
    log(message)
  }

  return async (current) => {
    let owned: OwnedRepo[]
    try {
      owned = await options.list()
    } catch (error) {
      warn(`repo discovery failed; keeping the ${current.length} repos: ${error instanceof RepoDiscoveryError ? error.message : errorName(error)}`)
      return []
    }
    const known = new Set([...never, ...current.map((spec) => spec.name.toLowerCase())])
    const added: RepoSpec[] = []
    for (const repo of owned) {
      const name = repo.name.toLowerCase()
      if (known.has(name)) continue
      const usable =
        REPO_NAME_PATTERN.test(name) &&
        !name.endsWith('.git') &&
        repo.url.startsWith(GITHUB_CLONE_PREFIX) &&
        isAllowedRemote(repo.url)
      if (!usable) {
        once(`skip:${name}`, `repo discovery: skipped "${name.slice(0, 100)}"; its name or clone URL cannot be used`)
        continue
      }
      if (current.length + added.length >= MAX_REPOS) {
        once('limit', `repo discovery: the limit of ${MAX_REPOS} repos is reached; not adding more`)
        break
      }
      known.add(name)
      added.push({ name, url: repo.url, branch: null })
    }
    if (added.length > 0) log(`repo discovery: ${added.length} new: ${added.map((spec) => spec.name).join(', ')}`)
    return added
  }
}

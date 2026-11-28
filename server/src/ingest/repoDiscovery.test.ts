import { describe, expect, it, vi } from 'vitest'
import type { RepoSpec } from './repoConfig.js'
import type { SyncResult } from './repoMirror.js'
import { createRepoDiscovery, listOwnedRepos, RepoDiscoveryError, type OwnedRepo } from './repoDiscovery.js'
import { startRepoScheduler, type RepoRoundResult } from './repoScheduler.js'

// T54 against a stubbed GitHub API: no network, no git.

// Built by concatenation so no literal token is ever committed.
const TOKEN = 'github_' + 'pat_' + 'T54'.repeat(10)

const owned = (name: string): { name: string; clone_url: string; private: boolean } => ({
  name,
  clone_url: `https://github.com/c-ent/${name}.git`,
  private: false,
})

interface StubCall {
  url: string
  headers: Record<string, string>
}

/** A `fetch` that answers `GET /user/repos` with `pages`, or with `status`. */
function stubGitHub(pages: unknown[][], status = 200, headers: Record<string, string> = {}) {
  const calls: StubCall[] = []
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } })
    if (status !== 200) return new Response(`{"message":"Bad credentials ${TOKEN}"}`, { status, headers })
    const page = Number(new URL(String(url)).searchParams.get('page'))
    return Response.json(pages[page - 1] ?? [])
  })
  return { fetch: fetchStub as unknown as typeof fetch, calls }
}

const spec = (name: string): RepoSpec => ({ name, url: `https://github.com/c-ent/${name}.git`, branch: null })

describe('listOwnedRepos', () => {
  it('lists the owner repos with the token in the header only, following pages', async () => {
    const first = Array.from({ length: 100 }, (_, i) => owned(`repo-${i}`))
    const github = stubGitHub([first, [owned('last')]])
    const repos = await listOwnedRepos({ token: TOKEN, fetch: github.fetch })
    expect(repos).toHaveLength(101)
    expect(repos.at(-1)).toEqual({ name: 'last', url: 'https://github.com/c-ent/last.git' })
    expect(github.calls).toHaveLength(2)
    expect(github.calls[0]!.url).toBe('https://api.github.com/user/repos?affiliation=owner&per_page=100&page=1')
    expect(github.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(github.calls.every((call) => !call.url.includes(TOKEN))).toBe(true)
  })

  it('reports an API error or the rate limit by status only, never the body or token', async () => {
    const denied = await listOwnedRepos({ token: TOKEN, fetch: stubGitHub([], 401).fetch }).catch((error: unknown) => error)
    expect(denied).toBeInstanceOf(RepoDiscoveryError)
    expect((denied as Error).message).toBe('GitHub answered 401')
    const limited = await listOwnedRepos({
      token: TOKEN,
      fetch: stubGitHub([], 403, { 'x-ratelimit-remaining': '0' }).fetch,
    }).catch((error: unknown) => error)
    expect((limited as Error).message).toBe('GitHub rate limit reached')
    expect(`${String(denied)} ${String(limited)}`).not.toContain(TOKEN)
  })

  it('rejects an unexpected answer', async () => {
    const github = stubGitHub([[{ unexpected: true }]])
    await expect(listOwnedRepos({ token: TOKEN, fetch: github.fetch })).rejects.toThrow('unexpected repo list')
  })
})

describe('createRepoDiscovery', () => {
  const setup = (list: () => Promise<OwnedRepo[]>, exclude: string[] = [], configured = ['pythia', 'notes', 'old-disabled']) => {
    const logs: string[] = []
    const discover = createRepoDiscovery({
      list,
      configured,
      exclude,
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    })
    return { discover, logs }
  }
  const ownedList = (...names: string[]) => async () => names.map((name) => ({ name, url: `https://github.com/c-ent/${name}.git` }))

  it('adds only repos not configured, lowercased, never configured or disabled ones', async () => {
    const { discover, logs } = setup(ownedList('Pythia', 'notes', 'old-disabled', 'Kitchen-App'))
    expect(await discover([spec('pythia'), spec('notes')])).toEqual([
      { name: 'kitchen-app', url: 'https://github.com/c-ent/Kitchen-App.git', branch: null },
    ])
    expect(logs).toEqual(['repo discovery: 1 new: kitchen-app'])
  })

  it('never adds a repo on the exclude list, whatever its case', async () => {
    const { discover } = setup(ownedList('pythia', 'Employer-Stuff', 'side-project'), ['employer-stuff'])
    expect((await discover([spec('pythia')])).map((repo) => repo.name)).toEqual(['side-project'])
  })

  it('keeps the current list when the listing fails, logging the reason without the token', async () => {
    const { discover, logs } = setup(async () => {
      throw new RepoDiscoveryError('GitHub rate limit reached')
    })
    expect(await discover([spec('pythia'), spec('notes')])).toEqual([])
    expect(logs).toEqual(['repo discovery failed; keeping the 2 repos: GitHub rate limit reached'])
    const other = setup(async () => {
      throw new TypeError(`fetch failed for ${TOKEN}`)
    })
    expect(await other.discover([spec('pythia')])).toEqual([])
    expect(other.logs).toEqual(['repo discovery failed; keeping the 1 repos: TypeError'])
  })

  it('skips a repo whose name or clone URL cannot be used, and says so once', async () => {
    const { discover, logs } = setup(async () => [
      { name: 'weird name', url: 'https://github.com/c-ent/weird.git' },
      { name: 'elsewhere', url: 'https://gitlab.example/c-ent/elsewhere.git' },
    ])
    expect(await discover([])).toEqual([])
    expect(await discover([])).toEqual([])
    expect(logs).toHaveLength(2)
  })
})

describe('startRepoScheduler with discovery', () => {
  it('clones and indexes a new repo in the next round; configured repos keep their commit', async () => {
    let onGitHub = ['pythia', 'notes']
    const logs: string[] = []
    const discover = createRepoDiscovery({
      list: async () => onGitHub.map((name) => ({ name, url: `https://github.com/c-ent/${name}.git` })),
      configured: ['pythia', 'notes'],
      exclude: ['secret-work'],
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    })
    const mirrors = new Set(['pythia', 'notes'])
    const sync = vi.fn(async (repo: RepoSpec): Promise<SyncResult> => {
      const cloned = !mirrors.has(repo.name)
      mirrors.add(repo.name)
      return { name: repo.name, cloned, commit: `${repo.name}-sha` }
    })
    const indexed: Array<[string, string | null]> = []
    const discovered: string[] = []
    const rounds: RepoRoundResult[] = []
    const scheduler = startRepoScheduler({
      repos: [spec('pythia'), spec('notes')],
      mirrorsDir: '/m',
      sync,
      discover,
      onDiscovered: (added) => discovered.push(...added.map((repo) => repo.name)),
      onSynced: (synced) => void indexed.push([synced.name, synced.commit]),
      onRound: (round) => void rounds.push(round),
    })
    await vi.waitFor(() => expect(rounds).toHaveLength(1))
    expect(rounds[0]!.synced.map((repo) => repo.name)).toEqual(['pythia', 'notes'])

    // A repo is created on GitHub, and one that must never be indexed.
    onGitHub = ['pythia', 'notes', 'new-repo', 'secret-work']
    const next = await scheduler.runNow()
    expect(discovered).toEqual(['new-repo'])
    expect(next.synced).toEqual([
      { name: 'pythia', cloned: false, commit: 'pythia-sha' },
      { name: 'notes', cloned: false, commit: 'notes-sha' },
      { name: 'new-repo', cloned: true, commit: 'new-repo-sha' },
    ])
    // The configured repos reach the indexer at the commit already indexed, so
    // its blob check skips every file (repoIndexer.test.ts); nothing is re-embedded.
    expect(indexed.filter(([name]) => name === 'pythia').map(([, commit]) => commit)).toEqual(['pythia-sha', 'pythia-sha'])
    expect(indexed).toContainEqual(['new-repo', 'new-repo-sha'])
    expect(sync.mock.calls.map(([repo]) => repo.name)).not.toContain('secret-work')
    expect(scheduler.runOne('new-repo')).not.toBeNull()

    // Deleted on GitHub: discovery never removes it.
    onGitHub = ['pythia']
    const after = await scheduler.runNow()
    expect(after.synced.map((repo) => repo.name)).toEqual(['pythia', 'notes', 'new-repo'])
    expect(logs).toEqual(['repo discovery: 1 new: new-repo'])
    await scheduler.close()
  })

  it('keeps the list and still fetches every repo when GitHub answers with an error', async () => {
    const warnings: string[] = []
    const discover = createRepoDiscovery({
      list: () => listOwnedRepos({ token: TOKEN, fetch: stubGitHub([], 500).fetch }),
      configured: ['pythia'],
      exclude: [],
      warn: (message) => warnings.push(message),
    })
    const scheduler = startRepoScheduler({
      repos: [spec('pythia')],
      mirrorsDir: '/m',
      sync: async (repo) => ({ name: repo.name, cloned: false, commit: 'sha' }),
      discover,
      onRound: () => {},
    })
    const result = await scheduler.runNow()
    expect(result).toEqual({ synced: [{ name: 'pythia', cloned: false, commit: 'sha' }], failed: [] })
    expect(warnings).toEqual(['repo discovery failed; keeping the 1 repos: GitHub answered 500'])
    expect(warnings.join('\n')).not.toContain(TOKEN)
    await scheduler.close()
  })

  it('never puts the token in a log line, whatever happens', async () => {
    const lines: string[] = []
    const spies = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
    )
    try {
      for (const fetchStub of [stubGitHub([[owned('fresh')]]).fetch, stubGitHub([], 401).fetch]) {
        const scheduler = startRepoScheduler({
          repos: [],
          mirrorsDir: '/m',
          githubToken: TOKEN,
          sync: async (repo) => ({ name: repo.name, cloned: true, commit: 'sha' }),
          discover: createRepoDiscovery({ list: () => listOwnedRepos({ token: TOKEN, fetch: fetchStub }), configured: [], exclude: [] }),
        })
        await scheduler.runNow()
        await scheduler.close()
      }
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).not.toContain(TOKEN)
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAllowedRemote, loadRepoConfig, MAX_REPOS, parseRepoConfig, RepoConfigError } from './repoConfig.js'

describe('isAllowedRemote', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'file:///srv/git/repo.git',
    path.resolve('/srv/git/repo'),
  ])('allows %s', (url) => {
    expect(isAllowedRemote(url)).toBe(true)
  })

  it.each([
    'http://github.com/owner/repo.git',
    'https://token@github.com/owner/repo.git',
    'https://user:pass@github.com/owner/repo.git',
    'ext::sh -c touch% /tmp/pwned',
    'fd::17',
    '--upload-pack=touch /tmp/pwned',
    '-oProxyCommand=x',
    'ftp://example.com/repo.git',
    'relative/path',
    'https://github.com/owner/repo name.git',
  ])('refuses %s', (url) => {
    expect(isAllowedRemote(url)).toBe(false)
  })
})

describe('parseRepoConfig', () => {
  it('returns enabled repos with the default branch as null', () => {
    expect(
      parseRepoConfig({
        repos: [
          { name: 'kitchen-app', url: 'https://github.com/owner/kitchen-app.git' },
          { name: 'notes.site', url: 'git@github.com:owner/notes.git', branch: 'release/v2' },
          { name: 'old', url: 'https://github.com/owner/old.git', enabled: false },
        ],
      }),
    ).toEqual([
      { name: 'kitchen-app', url: 'https://github.com/owner/kitchen-app.git', branch: null },
      { name: 'notes.site', url: 'git@github.com:owner/notes.git', branch: 'release/v2' },
    ])
  })

  it('rejects a kind key, so the file can never add a work source', () => {
    expect(() =>
      parseRepoConfig({ repos: [{ name: 'a', url: 'https://github.com/o/a.git', kind: 'work' }] }),
    ).toThrow(RepoConfigError)
  })

  it('rejects unknown top-level keys', () => {
    expect(() => parseRepoConfig({ repos: [], extra: true })).toThrow(RepoConfigError)
  })

  it.each(['', '../escape', 'a/b', '.hidden', 'repo.git', 'x'.repeat(101)])('rejects the name %j', (name) => {
    expect(() => parseRepoConfig({ repos: [{ name, url: 'https://github.com/o/a.git' }] })).toThrow(RepoConfigError)
  })

  it.each(['-evil', 'a..b', 'a//b', 'feature/', 'main.lock', 'has space'])('rejects the branch %j', (branch) => {
    expect(() => parseRepoConfig({ repos: [{ name: 'a', url: 'https://github.com/o/a.git', branch }] })).toThrow(
      RepoConfigError,
    )
  })

  it('rejects names that differ only by case', () => {
    expect(() =>
      parseRepoConfig({
        repos: [
          { name: 'App', url: 'https://github.com/o/a.git' },
          { name: 'app', url: 'https://github.com/o/b.git' },
        ],
      }),
    ).toThrow(/repos\.1\.name is used by another repo/)
  })

  it('rejects a URL with a token and never echoes it', () => {
    const token = 'ghp_' + 'A'.repeat(36)
    let message = ''
    try {
      parseRepoConfig({ repos: [{ name: 'a', url: `https://${token}@github.com/o/a.git` }] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('repos.0.url')
    expect(message).not.toContain(token)
  })

  it(`caps the list at ${MAX_REPOS} repos`, () => {
    const repos = Array.from({ length: MAX_REPOS + 1 }, (_, i) => ({ name: `r${i}`, url: 'https://github.com/o/r.git' }))
    expect(() => parseRepoConfig({ repos })).toThrow(RepoConfigError)
  })
})

describe('loadRepoConfig', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pythia-repocfg-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a JSON file, with or without a byte-order mark', async () => {
    const file = path.join(dir, 'repos.json')
    await writeFile(file, '﻿{"repos":[{"name":"a","url":"https://github.com/o/a.git"}]}')
    expect(await loadRepoConfig(file)).toEqual([{ name: 'a', url: 'https://github.com/o/a.git', branch: null }])
  })

  it('reports a missing file and invalid JSON as RepoConfigError', async () => {
    await expect(loadRepoConfig(path.join(dir, 'missing.json'))).rejects.toThrow(/Cannot read the repo config file/)
    const file = path.join(dir, 'bad.json')
    await writeFile(file, '{ repos: ')
    await expect(loadRepoConfig(file)).rejects.toThrow(/not valid JSON/)
  })
})

import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RepoSpec } from './repoConfig.js'
import { selectRepoFiles } from './repoFilter.js'
import { commitDates, listTree, mirrorPath, readBlob, readGitignores, RepoSyncError, syncRepo } from './repoMirror.js'

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', windowsHide: true })
}

async function put(root: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

let work: string
let source: string
let mirrors: string

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'pythia-repo-'))
  source = path.join(work, 'source')
  mirrors = path.join(work, 'mirrors')
  await mkdir(source)
  git(source, 'init', '--quiet', '--initial-branch=main')
  await put(source, 'README.md', '# Kitchen app\n')
  await put(source, 'package.json', '{"name":"kitchen"}\n')
  await put(source, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  await put(source, 'src/index.ts', 'export const answer = 42\n')
  await put(source, 'src/generated/out.ts', 'export {}\n')
  await put(source, 'src/.gitignore', 'generated/\n')
  await put(source, '.env', 'PLACEHOLDER=1\n')
  await put(source, 'node_modules/pkg/index.js', 'module.exports = 1\n')
  await put(source, 'assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  git(source, 'add', '--all', '--force')
  git(source, 'commit', '--quiet', '-m', 'first')
}, 60_000)

afterEach(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 5 })
}, 60_000)

const spec = (overrides: Partial<RepoSpec> = {}): RepoSpec => ({ name: 'kitchen', url: source, branch: null, ...overrides })

describe('syncRepo', { timeout: 60_000 }, () => {
  it('clones a bare mirror first, then fetches new commits', async () => {
    const first = await syncRepo(spec(), { mirrorsDir: mirrors })
    expect(first.cloned).toBe(true)
    expect(first.commit).toBe(git(source, 'rev-parse', 'HEAD').trim())

    const again = await syncRepo(spec(), { mirrorsDir: mirrors })
    expect(again).toEqual({ ...first, cloned: false })

    await put(source, 'src/extra.ts', 'export const b = 1\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'second')
    const fetched = await syncRepo(spec(), { mirrorsDir: mirrors })
    expect(fetched.cloned).toBe(false)
    expect(fetched.commit).toBe(git(source, 'rev-parse', 'HEAD').trim())
  })

  it('follows a force-push that rewrites history', async () => {
    await syncRepo(spec(), { mirrorsDir: mirrors })
    git(source, 'commit', '--quiet', '--amend', '-m', 'rewritten')
    const fetched = await syncRepo(spec(), { mirrorsDir: mirrors })
    expect(fetched.commit).toBe(git(source, 'rev-parse', 'HEAD').trim())
  })

  it('tracks a configured branch instead of the default', async () => {
    git(source, 'checkout', '--quiet', '-b', 'dev')
    await put(source, 'src/dev.ts', 'export const dev = true\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'dev')
    const devHead = git(source, 'rev-parse', 'HEAD').trim()
    git(source, 'checkout', '--quiet', 'main')

    const synced = await syncRepo(spec({ branch: 'dev' }), { mirrorsDir: mirrors })
    expect(synced.commit).toBe(devHead)
  })

  it('follows a change of the default branch', async () => {
    await syncRepo(spec(), { mirrorsDir: mirrors })
    git(source, 'checkout', '--quiet', '-b', 'trunk')
    await put(source, 'src/trunk.ts', 'export const t = 1\n')
    git(source, 'add', '--all')
    git(source, 'commit', '--quiet', '-m', 'trunk')
    const fetched = await syncRepo(spec(), { mirrorsDir: mirrors })
    expect(fetched.commit).toBe(git(source, 'rev-parse', 'HEAD').trim())
  })

  it('fails with a RepoSyncError for a missing remote and leaves no partial mirror', async () => {
    const missing = spec({ name: 'gone', url: path.join(work, 'does-not-exist') })
    await expect(syncRepo(missing, { mirrorsDir: mirrors })).rejects.toBeInstanceOf(RepoSyncError)
    await expect(syncRepo(missing, { mirrorsDir: mirrors })).rejects.toBeInstanceOf(RepoSyncError)
    await expect(access(mirrorPath(mirrors, 'gone'))).rejects.toThrow()
    await expect(access(`${mirrorPath(mirrors, 'gone')}.partial`)).rejects.toThrow()
  })

  it('fails for an unknown branch', async () => {
    await expect(syncRepo(spec({ branch: 'nope' }), { mirrorsDir: mirrors })).rejects.toBeInstanceOf(RepoSyncError)
  })

  it('syncs an empty repo (no commits) with commit null, then picks up the first commit later', async () => {
    const emptySource = path.join(work, 'empty-source')
    await mkdir(emptySource)
    git(emptySource, 'init', '--quiet', '--initial-branch=main')
    const emptySpec = spec({ name: 'whisksmith', url: emptySource, branch: null })

    const first = await syncRepo(emptySpec, { mirrorsDir: mirrors })
    expect(first).toEqual({ name: 'whisksmith', cloned: true, commit: null })

    const second = await syncRepo(emptySpec, { mirrorsDir: mirrors })
    expect(second).toEqual({ name: 'whisksmith', cloned: false, commit: null })

    await put(emptySource, 'README.md', '# WhiskSmith\n')
    git(emptySource, 'add', '--all')
    git(emptySource, 'commit', '--quiet', '-m', 'init')
    const afterCommit = await syncRepo(emptySpec, { mirrorsDir: mirrors })
    expect(afterCommit.cloned).toBe(false)
    expect(afterCommit.commit).toBe(git(emptySource, 'rev-parse', 'HEAD').trim())
  })

  it('still fails for an empty repo when an explicit branch is configured', async () => {
    const emptySource = path.join(work, 'empty-branch-source')
    await mkdir(emptySource)
    git(emptySource, 'init', '--quiet', '--initial-branch=main')
    await expect(
      syncRepo(spec({ name: 'whisksmith', url: emptySource, branch: 'main' }), { mirrorsDir: mirrors }),
    ).rejects.toBeInstanceOf(RepoSyncError)
  })
})

describe('listTree, readBlob and readGitignores', { timeout: 60_000 }, () => {
  it('feed selectRepoFiles with the tracked tree', async () => {
    const synced = await syncRepo(spec(), { mirrorsDir: mirrors })
    const dir = mirrorPath(mirrors, 'kitchen')
    const tree = await listTree(dir, synced.commit ?? '', { mirrorsDir: mirrors })
    expect(tree.map((file) => file.path).sort()).toEqual([
      '.env',
      'README.md',
      'assets/logo.png',
      'node_modules/pkg/index.js',
      'package.json',
      'pnpm-lock.yaml',
      'src/.gitignore',
      'src/generated/out.ts',
      'src/index.ts',
    ])
    const index = tree.find((file) => file.path === 'src/index.ts')
    expect(index?.size).toBe('export const answer = 42\n'.length)
    expect((await readBlob(dir, index?.blob ?? '', { mirrorsDir: mirrors })).toString('utf8')).toBe(
      'export const answer = 42\n',
    )

    const gitignores = await readGitignores(dir, tree, { mirrorsDir: mirrors })
    expect(gitignores).toEqual([{ dir: 'src', text: 'generated/\n' }])

    const selection = selectRepoFiles(tree, gitignores)
    expect(selection.included.map((file) => [file.path, file.kind, file.language])).toEqual([
      ['README.md', 'readme', 'markdown'],
      ['package.json', 'manifest', 'json'],
      ['src/index.ts', 'code', 'typescript'],
    ])
    expect(selection.skipped).toMatchObject({
      blocked: 1,
      gitignore: 1,
      lockfile: 1,
      'ignored-directory': 1,
      'not-allowlisted': 2,
    })
  })

  it('refuses a malformed blob id', async () => {
    await expect(readBlob(work, '--output=x', { mirrorsDir: mirrors })).rejects.toBeInstanceOf(RepoSyncError)
  })

  it('reads first and latest commit timestamps from the mirror', async () => {
    const timedSource = path.join(work, 'timed-source')
    await mkdir(timedSource)
    git(timedSource, 'init', '--quiet', '--initial-branch=main')
    await put(timedSource, 'README.md', '# Timed\n')
    git(timedSource, 'add', '--all')
    execFileSync('git', [...IDENTITY, 'commit', '--quiet', '-m', 'init'], {
      cwd: timedSource,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-10T08:00:00Z', GIT_COMMITTER_DATE: '2026-01-10T08:00:00Z' },
      windowsHide: true,
    })
    await put(timedSource, 'README.md', '# Timed v2\n')
    git(timedSource, 'add', '--all')
    execFileSync('git', [...IDENTITY, 'commit', '--quiet', '-m', 'update'], {
      cwd: timedSource,
      env: { ...process.env, GIT_AUTHOR_DATE: '2026-11-25T14:30:00Z', GIT_COMMITTER_DATE: '2026-11-25T14:30:00Z' },
      windowsHide: true,
    })

    const synced = await syncRepo({ name: 'timed', url: timedSource, branch: null }, { mirrorsDir: mirrors })
    const dates = await commitDates(mirrorPath(mirrors, 'timed'), synced.commit ?? '', { mirrorsDir: mirrors })
    expect(dates.firstCommitAt?.toISOString()).toBe('2026-01-10T08:00:00.000Z')
    expect(dates.lastCommitAt?.toISOString()).toBe('2026-11-25T14:30:00.000Z')
  })
})

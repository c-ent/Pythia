import { execFile } from 'node:child_process'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RepoSpec } from './repoConfig.js'
import type { GitignoreFile, RepoTreeFile } from './repoFilter.js'

const run = promisify(execFile)

/**
 * Bare, read-only mirrors of the configured repos (R9). Git runs with an
 * argument list (never a shell), no terminal prompts, no hooks and no
 * command-running transports. A GitHub token, when set, reaches git through
 * environment config (`GIT_CONFIG_*`), so it never appears in process
 * arguments, in the mirror's config file or in logs.
 */

export class RepoSyncError extends Error {
  override name = 'RepoSyncError'
}

export interface MirrorOptions {
  /** Directory holding one bare mirror per repo, named after the repo. */
  mirrorsDir: string
  githubToken?: string | null
  /** Per git command; clones of large repos need minutes. */
  timeoutMs?: number
}

export interface SyncResult {
  name: string
  cloned: boolean
  /** Commit the indexed branch points at after the fetch. */
  commit: string
}

const MAX_OUTPUT = 64 * 1024 * 1024

function gitEnv(token: string | null | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const config: Array<[string, string]> = [
    ['protocol.ext.allow', 'never'],
    ['protocol.fd.allow', 'never'],
    ['core.hooksPath', path.join(path.sep, 'nonexistent-pythia-hooks')],
    ['credential.helper', ''],
  ]
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    config.push(['http.https://github.com/.extraheader', `Authorization: Basic ${basic}`])
  }
  env.GIT_CONFIG_COUNT = String(config.length)
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return env
}

async function git(args: string[], options: MirrorOptions, cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      env: gitEnv(options.githubToken),
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    // stderr can echo the remote URL; keep only the first line and drop anything credential-shaped.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    const first = stderr.split('\n').find((line) => line.trim() !== '') ?? (error as Error).message
    throw new RepoSyncError(`git ${args[0]} failed: ${redact(first.trim())}`)
  }
}

const redact = (text: string): string => text.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300)

async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export const mirrorPath = (mirrorsDir: string, name: string): string => path.join(mirrorsDir, `${name}.git`)

/** The ref the indexer reads: the configured branch, or the remote's default (HEAD). */
const trackedRef = (spec: RepoSpec): string => (spec.branch === null ? 'HEAD' : `refs/heads/${spec.branch}`)

/** Clones the repo as a bare mirror on first run, fetches (with prune) after that. */
export async function syncRepo(spec: RepoSpec, options: MirrorOptions): Promise<SyncResult> {
  const dir = mirrorPath(options.mirrorsDir, spec.name)
  let cloned = false
  if (!(await exists(path.join(dir, 'HEAD')))) {
    await mkdir(options.mirrorsDir, { recursive: true })
    // Clone into a temporary name so an interrupted clone never looks like a mirror.
    const partial = `${dir}.partial`
    await rm(partial, { recursive: true, force: true })
    const branchArgs = spec.branch === null ? [] : ['--branch', spec.branch, '--single-branch']
    await git(['clone', '--bare', '--quiet', '--no-tags', ...branchArgs, '--', spec.url, partial], options)
    await rename(partial, dir)
    cloned = true
  } else {
    const refspec =
      spec.branch === null ? '+refs/heads/*:refs/heads/*' : `+refs/heads/${spec.branch}:refs/heads/${spec.branch}`
    await git(['fetch', '--quiet', '--prune', '--no-tags', '--', spec.url, refspec], options, dir)
    if (spec.branch === null) await followDefaultBranch(spec.url, dir, options)
  }
  const commit = (await git(['rev-parse', '--verify', `${trackedRef(spec)}^{commit}`], options, dir)).trim()
  return { name: spec.name, cloned, commit }
}

/** Points the mirror's HEAD at the remote's current default branch, if the remote reports one. */
async function followDefaultBranch(url: string, dir: string, options: MirrorOptions): Promise<void> {
  const out = await git(['ls-remote', '--symref', '--', url, 'HEAD'], options, dir)
  const match = /^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/m.exec(out)
  if (match?.[1] !== undefined) await git(['symbolic-ref', 'HEAD', match[1]], options, dir)
}

export interface MirrorTreeFile extends RepoTreeFile {
  /** Blob id; unchanged content keeps its id, so the indexer can skip it. */
  blob: string
}

/** Lists every regular file at `commit` with its size. Symlinks and submodules are left out. */
export async function listTree(dir: string, commit: string, options: MirrorOptions): Promise<MirrorTreeFile[]> {
  const out = await git(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], options, dir)
  const files: MirrorTreeFile[] = []
  for (const entry of out.split('\0')) {
    if (entry === '') continue
    const tab = entry.indexOf('\t')
    const [mode, type, blob, size] = entry.slice(0, tab).split(/\s+/)
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue
    files.push({ path: entry.slice(tab + 1), size: Number(size), blob: blob ?? '' })
  }
  return files
}

/** Reads one blob as bytes. */
export async function readBlob(dir: string, blob: string, options: MirrorOptions): Promise<Buffer> {
  if (!/^[0-9a-f]{40,64}$/.test(blob)) throw new RepoSyncError('invalid blob id')
  try {
    const { stdout } = await run('git', ['cat-file', 'blob', blob], {
      cwd: dir,
      env: gitEnv(options.githubToken),
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      encoding: 'buffer',
    })
    return stdout
  } catch {
    throw new RepoSyncError('git cat-file failed')
  }
}

export interface RepoCommitDates {
  /** Earliest root commit timestamp reachable from `commit`, or null if unavailable. */
  firstCommitAt: Date | null
  /** Timestamp of `commit`, or null if unavailable. */
  lastCommitAt: Date | null
}

const parseCommitDate = (raw: string): Date | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? null : new Date(ms)
}

/** Reads the earliest root commit and latest commit timestamps for `commit` from the mirror. */
export async function commitDates(dir: string, commit: string, options: MirrorOptions): Promise<RepoCommitDates> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new RepoSyncError('invalid commit id')
  const lastRaw = await git(['show', '-s', '--format=%cI', commit], options, dir)
  const lastCommitAt = parseCommitDate(lastRaw)

  const rootsRaw = await git(['rev-list', '--max-parents=0', commit], options, dir)
  const roots = rootsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40,64}$/.test(line))
    .slice(0, 20)
  if (roots.length === 0) return { firstCommitAt: lastCommitAt, lastCommitAt }

  const firstRaw = await git(['show', '-s', '--format=%cI', ...roots], options, dir)
  const dates = firstRaw
    .split(/\r?\n/)
    .map(parseCommitDate)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => a.getTime() - b.getTime())
  return { firstCommitAt: dates[0] ?? lastCommitAt, lastCommitAt }
}

/** The `.gitignore` files tracked at `commit`, for `selectRepoFiles`. */
export async function readGitignores(
  dir: string,
  tree: readonly MirrorTreeFile[],
  options: MirrorOptions,
): Promise<GitignoreFile[]> {
  const files: GitignoreFile[] = []
  for (const file of tree) {
    if (file.path !== '.gitignore' && !file.path.endsWith('/.gitignore')) continue
    if (file.size > 1024 * 1024) continue
    const text = (await readBlob(dir, file.blob, options)).toString('utf8')
    files.push({ dir: path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path), text })
  }
  return files
}

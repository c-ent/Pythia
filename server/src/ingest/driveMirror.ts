import { spawn } from 'node:child_process'
import { DRIVE_CONVERTED_EXTENSIONS } from './driveConvert.js'
import { DRIVE_DOCUMENT_EXTENSIONS } from './driveExtract.js'

/**
 * The one-way Drive pull (R19, T61): `rclone sync` of the owner's My Drive
 * into the mirror (`/data/gdrive`). Only My Drive: no `--drive-shared-with-me`,
 * no shared drive flags, and shortcuts (which can point at files shared with
 * the owner) are skipped. Google Docs, Sheets and Slides are exported as
 * `.docx`, `.xlsx` and `.pptx`. Folders on the exclude list and non-document
 * files (videos, photos, archives, etc.) are never pulled and are deleted
 * from the mirror if an earlier pull brought them in.
 *
 * rclone's output is never logged or returned: it can name files and, on a
 * login error, quote parts of the OAuth exchange. Callers get an error class
 * and counts only.
 */

export const DEFAULT_PULL_TIMEOUT_MS = 6 * 60 * 60_000
export const DRIVE_EXPORT_FORMATS = 'docx,xlsx,pptx'

const DOCUMENT_EXTENSION_ALTERNATION = [...DRIVE_DOCUMENT_EXTENSIONS, ...DRIVE_CONVERTED_EXTENSIONS]
  .map((ext) => ext.replace(/^\./, ''))
  .join('|')

/**
 * Rclone `--filter` rule matching only supported document extensions
 * (case-insensitive) so media and archives stay out of the mirror.
 */
export const DRIVE_DOCUMENT_FILTER = `+ {{(?i).*\\.(${DOCUMENT_EXTENSION_ALTERNATION})$}}`

/**
 * Static `--filter` rules applied after folder excludes: drop dotfiles and
 * dotfolders, keep supported document files, and reject everything else.
 */
export const DRIVE_PULL_FILTERS: readonly string[] = ['- .*/**', '- **/.*/**', '- .*', DRIVE_DOCUMENT_FILTER, '- *']

export interface DrivePullOptions {
  /** rclone remote, e.g. `gdrive:` (My Drive root of the remote). */
  remote: string
  /** Absolute path of the mirror. */
  dest: string
  /** Normalized Drive-relative folders (driveConfig.ts). */
  exclude: readonly string[]
  /** rclone.conf path; absent means rclone's default. */
  rcloneConfig?: string | null
}

export interface DrivePullResult {
  /** Files rclone found twice under one name in a folder and pulled once. */
  duplicates: number
}

/** The Google login is revoked or expired: it must be renewed on the host (`rclone config reconnect`). */
export class DriveLoginError extends Error {
  override name = 'DriveLoginError'
}

/** The pull failed for any other reason (network, quota, rclone missing, timeout). */
export class DrivePullError extends Error {
  override name = 'DrivePullError'
}

/** Escapes rclone filter glob characters so a folder name matches only itself. */
export function escapeRcloneGlob(text: string): string {
  return text.replace(/[\\*?[\]{}]/g, (char) => `\\${char}`)
}

/** A remote name and an optional path, never a local path or an option. */
export const DRIVE_REMOTE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_. -]*:\P{Cc}*$/u

export function rcloneArgs(options: DrivePullOptions): string[] {
  if (!DRIVE_REMOTE_PATTERN.test(options.remote)) throw new DrivePullError('The Drive remote is not an rclone remote')
  const args = [
    'sync',
    options.remote,
    options.dest,
    '--drive-scope',
    'drive.readonly',
    '--drive-export-formats',
    DRIVE_EXPORT_FORMATS,
    '--drive-skip-shortcuts',
    '--delete-excluded',
    '--log-level',
    'NOTICE',
    '--stats',
    '0',
  ]
  // Order matters in rclone `--filter`: exclude folders first, skip dotfiles
  // and dotfolders, include supported document files, then reject the rest.
  for (const folder of options.exclude) args.push('--filter', `- /${escapeRcloneGlob(folder)}/**`)
  for (const rule of DRIVE_PULL_FILTERS) args.push('--filter', rule)
  if (options.rcloneConfig != null) args.push('--config', options.rcloneConfig)
  return args
}

/** Runs rclone with the given arguments. Injected in tests. */
export type RcloneRunner = (args: readonly string[]) => Promise<DrivePullResult>

const LOGIN_FAILURE =
  /invalid_grant|couldn't fetch token|cannot fetch token|token (has )?expired|unauthorized_client|invalid_client|401 unauthorized|reconnect/i
const DUPLICATE = /duplicate object found/i

export interface RcloneRunnerOptions {
  /** rclone binary; `rclone` on PATH by default. */
  command?: string
  /** Arguments placed before rclone's (tests run a node script as the command). */
  prefixArgs?: readonly string[]
  timeoutMs?: number
  /** Environment for rclone. Defaults to PATH, HOME and LANG only, so no server secret reaches it. */
  env?: NodeJS.ProcessEnv
}

export function createRcloneRunner(options: RcloneRunnerOptions = {}): RcloneRunner {
  const command = options.command ?? 'rclone'
  const timeoutMs = options.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS
  const env = options.env ?? {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
  }
  return (args) =>
    new Promise<DrivePullResult>((resolve, reject) => {
      let duplicates = 0
      let loginFailed = false
      let pending = ''
      let timedOut = false
      const child = spawn(command, [...(options.prefixArgs ?? []), ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
      timer.unref()
      const scan = (line: string): void => {
        if (DUPLICATE.test(line)) duplicates += 1
        if (LOGIN_FAILURE.test(line)) loginFailed = true
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (data: string) => {
        const lines = (pending + data).split('\n')
        pending = lines.pop() ?? ''
        // A runaway line is cut rather than kept in memory.
        if (pending.length > 64_000) pending = pending.slice(-64_000)
        for (const line of lines) scan(line)
      })
      child.on('error', () => {
        clearTimeout(timer)
        reject(new DrivePullError('rclone could not be started'))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (pending !== '') scan(pending)
        if (code === 0 && !timedOut) resolve({ duplicates })
        else if (loginFailed) reject(new DriveLoginError('The Drive login must be renewed on the host'))
        else reject(new DrivePullError(timedOut ? 'rclone timed out' : `rclone exited with code ${code ?? 'signal'}`))
      })
    })
}

/** One pull of My Drive into the mirror. */
export function pullDrive(options: DrivePullOptions, run: RcloneRunner): Promise<DrivePullResult> {
  return run(rcloneArgs(options))
}

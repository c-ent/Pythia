import { readFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * The Drive exclude list (R19, T61), read from a JSON file on the host
 * (`/config/gdrive.json`), like the repo config:
 *
 *   { "exclude": ["Work", "Clients/Acme"] }
 *
 * Each entry is a folder path relative to the root of My Drive. Its files are
 * never pulled (passed to rclone as `--exclude`) and never indexed; documents
 * already indexed under it are removed at the next round. The file is read
 * again at the start of every round, so an edit on the host applies without a
 * restart. The schema is strict: a typo is rejected rather than ignored.
 */

export interface DriveConfigFile {
  /** Normalized folder paths (no leading or trailing `/`), sorted, no duplicates. */
  exclude: string[]
}

export class DriveConfigError extends Error {
  override name = 'DriveConfigError'
}

export const MAX_DRIVE_EXCLUDES = 200
const MAX_FOLDER_LENGTH = 500

const fileSchema = z.strictObject({
  exclude: z.array(z.string().max(MAX_FOLDER_LENGTH)).max(MAX_DRIVE_EXCLUDES).default([]),
})

/** A Drive-relative folder path without leading or trailing `/`, or null when it is not one. */
export function normalizeDriveFolder(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || /\p{Cc}/u.test(trimmed)) return null
  const parts = trimmed.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return parts.join('/')
}

export function parseDriveConfigFile(value: unknown): DriveConfigFile {
  const result = fileSchema.safeParse(value)
  if (!result.success) {
    // Paths and issue codes only: never the values, which are folder names.
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || 'file'} ${issue.code}`)
    throw new DriveConfigError(`The Drive config file is not valid: ${problems.join('; ')}`)
  }
  const folders = new Set<string>()
  result.data.exclude.forEach((entry, index) => {
    const folder = normalizeDriveFolder(entry)
    if (folder === null) throw new DriveConfigError(`exclude entry ${index + 1} is not a Drive folder path`)
    folders.add(folder)
  })
  return { exclude: [...folders].sort() }
}

/** Null means no file is configured: nothing is excluded. */
export async function loadDriveConfigFile(file: string | null): Promise<DriveConfigFile> {
  if (file === null) return { exclude: [] }
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read error'
    throw new DriveConfigError(`Cannot read the Drive config file (${code})`)
  }
  let value: unknown
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new DriveConfigError('The Drive config file is not valid JSON')
  }
  return parseDriveConfigFile(value)
}

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { driveExtension, extractDriveFile, type DriveExtraction, type DriveExtractOptions } from './driveExtract.js'

const run = promisify(execFile)

/**
 * Old Office and OpenDocument files in Drive (R19): converted with
 * LibreOffice headless to the OOXML format the T56, T58 and T59 extractors
 * read. The converter only ever sees bytes: each file is written to its own
 * temp dir outside the Drive mirror, converted there, read back and the dir
 * removed, so the mirror is never written to.
 */

export type OfficeTarget = 'docx' | 'xlsx' | 'pptx'

/** Extension (with its dot) to the format it is converted to. */
export const DRIVE_CONVERSIONS: Readonly<Record<string, OfficeTarget>> = {
  '.doc': 'docx',
  '.rtf': 'docx',
  '.odt': 'docx',
  '.xls': 'xlsx',
  '.ods': 'xlsx',
  '.ppt': 'pptx',
  '.odp': 'pptx',
}

export const DRIVE_CONVERTED_EXTENSIONS: readonly string[] = Object.keys(DRIVE_CONVERSIONS)

/** Converts one file's bytes; rejects when the conversion fails or times out. */
export type OfficeConverter = (bytes: Uint8Array, fromExtension: string, to: OfficeTarget) => Promise<Uint8Array>

/** Carries no file name or content, so it is safe to count and log. */
export class ConversionError extends Error {
  override name = 'ConversionError'
}

export interface SofficeOptions {
  /** The LibreOffice binary; `soffice` on PATH by default. */
  command?: string
  /** Arguments placed before LibreOffice's own; tests run a stand-in script this way. */
  prefixArgs?: readonly string[]
  /** Per file; LibreOffice is killed when it runs over. */
  timeoutMs?: number
  /** Parent of the per-file temp dirs; never the Drive mirror. */
  tempRoot?: string
}

export const DEFAULT_CONVERT_TIMEOUT_MS = 120_000

const MAX_OUTPUT = 1024 * 1024

/**
 * A converter that runs `soffice --headless --convert-to`, one file at a
 * time. LibreOffice gets a fresh profile and home in the temp dir and no
 * environment beyond PATH, so no token or setting of the server reaches it.
 * The input is always named `input.<ext>`: the owner's file name never
 * becomes a process argument.
 */
export function createSofficeConverter(options: SofficeOptions = {}): OfficeConverter {
  const command = options.command ?? 'soffice'
  const prefixArgs = options.prefixArgs ?? []
  const timeout = options.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS
  const tempRoot = options.tempRoot ?? tmpdir()

  const convertOne: OfficeConverter = async (bytes, fromExtension, to) => {
    if (!/^\.[a-z0-9]+$/.test(fromExtension)) throw new ConversionError('unsupported extension')
    const dir = await mkdtemp(path.join(tempRoot, 'pythia-convert-'))
    try {
      const input = path.join(dir, `input${fromExtension}`)
      const outDir = path.join(dir, 'out')
      await mkdir(outDir)
      await writeFile(input, bytes)
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, LANG: 'C.UTF-8' }
      if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot
      try {
        await run(
          command,
          [
            ...prefixArgs,
            `-env:UserInstallation=${pathToFileURL(path.join(dir, 'profile')).href}`,
            '--headless',
            '--norestore',
            '--nolockcheck',
            '--nodefault',
            '--nologo',
            '--convert-to',
            to,
            '--outdir',
            outDir,
            input,
          ],
          { cwd: dir, env, timeout, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true },
        )
      } catch (error) {
        throw new ConversionError((error as { killed?: boolean }).killed === true ? 'timed out' : 'exited with an error')
      }
      try {
        return new Uint8Array(await readFile(path.join(outDir, `input.${to}`)))
      } catch {
        // LibreOffice exits 0 on files it cannot open; no output is the only sign.
        throw new ConversionError('wrote no output')
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  return (bytes, fromExtension, to) => {
    const result = queue.then(() => convertOne(bytes, fromExtension, to))
    queue = result.catch(() => undefined)
    return result
  }
}

export interface DriveConvertOptions extends DriveExtractOptions {
  converter: OfficeConverter
}

/**
 * `extractDriveFile`, plus old Office and OpenDocument files: those are
 * converted first and handed to the extractor for the format they became,
 * keeping their title. A failed conversion is skipped as `conversion_failed`.
 */
export async function extractDriveFileConverted(
  filePath: string,
  bytes: Uint8Array,
  options: DriveConvertOptions,
): Promise<DriveExtraction> {
  const { converter, ...extractOptions } = options
  const extension = driveExtension(filePath)
  const target = DRIVE_CONVERSIONS[extension]
  if (target === undefined) return extractDriveFile(filePath, bytes, extractOptions)
  let converted: Uint8Array
  try {
    converted = await converter(bytes, extension, target)
  } catch {
    return { kind: 'skipped', reason: 'conversion_failed' }
  }
  return extractDriveFile(`${filePath.slice(0, -extension.length)}.${target}`, converted, extractOptions)
}

import type { DriveIndexResult } from './driveIndexer.js'

/**
 * The Drive round (R19, T61): pull My Drive with rclone, then index the
 * mirror. Runs at startup, every 30 minutes and on Sync now. A round never
 * overlaps another: Sync now during a round gets the round in progress. A
 * failed pull keeps the index as it is (the indexer is not run) and the next
 * round retries.
 */

export const DEFAULT_DRIVE_INTERVAL_MS = 30 * 60_000

export interface DriveSchedulerOptions {
  /** One round: read the exclude list, pull, index. Throws when the pull fails. */
  round: () => Promise<DriveIndexResult>
  intervalMs?: number
  /** Called with each finished round's result; a failing hook is logged by class. */
  onRound?: (result: DriveIndexResult) => unknown
  /** Called with each failed round's error. */
  onFailed?: (error: unknown) => unknown
  /** Error classes only. */
  log?: (message: string) => void
}

export interface DriveScheduler {
  /** Runs a round now, or returns the one in progress. Rejects when the round failed. */
  runNow(): Promise<DriveIndexResult>
  /** A round is running, whoever started it (startup, the timer or `runNow`). */
  state(): { running: boolean }
  close(): Promise<void>
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'unknown')

export function startDriveScheduler(options: DriveSchedulerOptions): DriveScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_DRIVE_INTERVAL_MS
  const log = options.log ?? ((message: string) => console.error(message))
  let closed = false
  let current: Promise<DriveIndexResult> | null = null
  let timer: NodeJS.Timeout | null = null

  const report = async (hook: (() => unknown) | undefined): Promise<void> => {
    if (hook === undefined) return
    try {
      await hook()
    } catch (error) {
      log(`drive round report failed: ${errorName(error)}`)
    }
  }

  async function round(): Promise<DriveIndexResult> {
    try {
      const result = await options.round()
      await report(options.onRound && (() => options.onRound?.(result)))
      return result
    } catch (error) {
      await report(options.onFailed && (() => options.onFailed?.(error)))
      throw error
    }
  }

  function schedule(): void {
    if (closed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      // The timer's round has no caller; its failure is already reported.
      runNow().catch(() => undefined)
    }, intervalMs)
    timer.unref()
  }

  function runNow(): Promise<DriveIndexResult> {
    if (current === null) {
      current = round().finally(() => {
        current = null
        schedule()
      })
    }
    return current
  }

  runNow().catch(() => undefined)

  return {
    runNow,
    state: () => ({ running: current !== null }),
    async close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      await current?.catch(() => undefined)
    },
  }
}

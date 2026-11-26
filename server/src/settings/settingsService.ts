import { z } from 'zod'
import {
  cleanExclusions,
  normalizeVaultPath,
  sortExclusions,
  type LlmExclusion,
  type LlmExclusionStore,
} from '../ingest/llmExclusions.js'

export const MAX_LLM_EXCLUSIONS = 500
const MAX_PATH_LENGTH = 1024
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

const exclusionSchema = z
  .object({
    kind: z.enum(['folder', 'note']),
    path: z
      .string()
      .max(MAX_PATH_LENGTH)
      .refine((path) => !CONTROL_CHARACTER.test(path), 'path must not contain control characters'),
  })
  .transform((value, ctx): LlmExclusion => {
    const path = normalizeVaultPath(value.path)
    if (path === null) {
      ctx.addIssue({ code: 'custom', message: 'path must be a vault-relative path without ..', path: ['path'] })
      return z.NEVER
    }
    // A single note is matched by its full file name; without `.md` it would never match.
    if (value.kind === 'note' && !/\.md$/i.test(path)) {
      ctx.addIssue({ code: 'custom', message: 'a note path must end in .md', path: ['path'] })
      return z.NEVER
    }
    return { kind: value.kind, path }
  })

/** Body of `PUT /api/settings/llm-exclusions`: the whole list, replacing the stored one. */
export const llmExclusionsInputSchema = z.object({
  exclusions: z.array(exclusionSchema).max(MAX_LLM_EXCLUSIONS),
})

export interface SettingsService {
  getLlmExclusions(): Promise<LlmExclusion[]>
  /**
   * Saves the whole list (validated by `llmExclusionsInputSchema`), deduplicated
   * and sorted, and returns it. New exclusions hold once this resolves; notes
   * that were given back follow when the background refresh has run.
   */
  setLlmExclusions(list: readonly LlmExclusion[]): Promise<LlmExclusion[]>
}

export interface SettingsServiceOptions {
  exclusions: LlmExclusionStore
  /** Re-applies the list to stored vault notes without embedding; absent when vault indexing is off. */
  refreshAllowLlm?: () => Promise<unknown>
  log?: (message: string) => void
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const log = options.log ?? console.error
  return {
    async getLlmExclusions() {
      return sortExclusions(await options.exclusions.list())
    },

    async setLlmExclusions(list) {
      const clean = cleanExclusions(list)
      await options.exclusions.replace(clean)
      const refresh = options.refreshAllowLlm
      // Not awaited: it waits behind any running scan, which can take minutes.
      if (refresh !== undefined) {
        void refresh().catch((error: unknown) => {
          log(`allow_llm refresh failed: ${error instanceof Error ? error.name : 'unknown'}`)
        })
      }
      return clean
    },
  }
}

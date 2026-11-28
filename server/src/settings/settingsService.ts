import { z } from 'zod'
import {
  cleanExclusions,
  LLM_EXCLUSION_KINDS,
  normalizeRulePath,
  sortExclusions,
  type LlmExclusion,
  type LlmExclusionKind,
  type LlmExclusionStore,
} from '../ingest/llmExclusions.js'

export const MAX_LLM_EXCLUSIONS = 500
const MAX_PATH_LENGTH = 1024
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

const INVALID_PATH: Record<LlmExclusionKind, string> = {
  folder: 'path must be a vault-relative path without ..',
  note: 'path must be a vault-relative path without ..',
  tag: 'path must be a tag: letters, digits, "_", "-" or "/", with or without #',
  repo: 'path must be a repo name: 1–100 letters, digits, ".", "_" or "-", starting with a letter or digit',
  keep: 'path is not used for keep',
  gdrive: 'path must be / for the whole Drive or a Drive folder path without ..',
}

const exclusionSchema = z
  .object({
    kind: z.enum(LLM_EXCLUSION_KINDS),
    // A `keep` rule needs no path: it covers all of Google Keep. A `gdrive`
    // rule without a path (or `/`) covers the whole Drive.
    path: z
      .string()
      .max(MAX_PATH_LENGTH)
      .refine((path) => !CONTROL_CHARACTER.test(path), 'path must not contain control characters')
      .default(''),
  })
  .transform((value, ctx): LlmExclusion => {
    const path = normalizeRulePath(value.kind, value.path)
    if (path === null) {
      ctx.addIssue({ code: 'custom', message: INVALID_PATH[value.kind], path: ['path'] })
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

/** A rule with how many stored documents it covers now (R16). */
export interface CountedLlmExclusion extends LlmExclusion {
  documents: number
}

export interface SettingsService {
  getLlmExclusions(): Promise<CountedLlmExclusion[]>
  /**
   * Saves the whole list (validated by `llmExclusionsInputSchema`), deduplicated
   * and sorted, and returns it with counts. New exclusions, and repo and Keep
   * rules either way, hold once this resolves; vault notes that were given
   * back follow when the background refresh has run.
   */
  setLlmExclusions(list: readonly LlmExclusion[]): Promise<CountedLlmExclusion[]>
}

export interface SettingsServiceOptions {
  exclusions: LlmExclusionStore
  /** Re-applies the list to stored vault notes without embedding; absent when vault indexing is off. */
  refreshAllowLlm?: () => Promise<unknown>
  log?: (message: string) => void
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const log = options.log ?? console.error

  const withCounts = async (list: LlmExclusion[]): Promise<CountedLlmExclusion[]> => {
    const counts = await options.exclusions.countDocuments(list)
    return list.map((exclusion, i) => ({ ...exclusion, documents: counts[i] ?? 0 }))
  }

  return {
    async getLlmExclusions() {
      return withCounts(sortExclusions(await options.exclusions.list()))
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
      return withCounts(clean)
    },
  }
}

import type { LlmExclusion } from '../api/settings'

/**
 * "Allow Ask to read this repo" (R16) is a `repo` rule on the "Kept away from
 * Gemini" list: a rule means locked. Names match without regard to case, like
 * the Settings list (`sameRule` in screens/settings/gemini.ts).
 */

const isRule = (rule: LlmExclusion, name: string): boolean =>
  rule.kind === 'repo' && rule.path.toLowerCase() === name.toLowerCase()

export function isRepoLocked(rules: readonly LlmExclusion[], name: string): boolean {
  return rules.some((rule) => isRule(rule, name))
}

/**
 * The whole list to save: every other rule kept as it is, and this repo's rule
 * added (locked) or taken out (allowed).
 */
export function withRepoRule(rules: readonly LlmExclusion[], name: string, locked: boolean): LlmExclusion[] {
  const rest = rules.filter((rule) => !isRule(rule, name)).map(({ kind, path }) => ({ kind, path }))
  return locked ? [...rest, { kind: 'repo', path: name }] : rest
}

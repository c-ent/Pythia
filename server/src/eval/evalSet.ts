import { z } from 'zod'
import { SEARCHABLE_KINDS } from '../db/searchStore.js'

/**
 * The evaluation set (T23, R12): questions the owner wrote, each with the
 * document(s) that should come back. A question counts as a hit when any
 * expected document is in the top `k` results (hit@5 by default).
 */

const kindSchema = z.enum(SEARCHABLE_KINDS)

export const expectedDocSchema = z.object({
  /** Path as stored: vault-relative for notes, repo-relative for repo files, `Keep/<title>` for Keep. */
  path: z.string().min(1),
  /** Narrows the match when the same path exists in several sources. */
  kind: kindSchema.optional(),
  /** Source name, e.g. the repo name. */
  name: z.string().min(1).optional(),
})

export const evalQuestionSchema = z.object({
  id: z.string().min(1).optional(),
  question: z.string().trim().min(1).max(1000),
  expected: z.array(expectedDocSchema).min(1),
  /** Limits the search to these source kinds, like the web app's filter chips. */
  sources: z.array(kindSchema).min(1).optional(),
})

export const evalSetSchema = z.object({
  questions: z.array(evalQuestionSchema).min(1),
})

export type ExpectedDoc = z.infer<typeof expectedDocSchema>
export type EvalQuestion = z.infer<typeof evalQuestionSchema>
export type EvalSet = z.infer<typeof evalSetSchema>

/** The roadmap's target size; a different count still runs, with a warning. */
export const EXPECTED_QUESTION_COUNT = 30

export function parseEvalSet(text: string): EvalSet {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The evaluation file is not valid JSON')
  }
  const parsed = evalSetSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}`
    throw new Error(`The evaluation file is not in the expected shape${where}: ${issue?.message ?? 'invalid'}`)
  }
  return parsed.data
}

export interface RankedDoc {
  source: { kind: string; name: string }
  path: string
  title: string
}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()

export function matches(result: RankedDoc, expected: ExpectedDoc): boolean {
  if (expected.kind !== undefined && result.source.kind !== expected.kind) return false
  if (expected.name !== undefined && result.source.name !== expected.name) return false
  return normalizePath(result.path) === normalizePath(expected.path)
}

export interface QuestionScore {
  id: string
  question: string
  hit: boolean
  /** 1-based rank of the first expected document in all returned results; null when absent. */
  rank: number | null
  /** The top `k` results, for the report. */
  top: RankedDoc[]
  /** Set when the search itself failed. */
  error: string | null
  degraded: boolean
}

export function scoreQuestion(
  question: EvalQuestion,
  index: number,
  results: readonly RankedDoc[],
  k: number,
  degraded = false,
): QuestionScore {
  const at = results.findIndex((result) => question.expected.some((expected) => matches(result, expected)))
  const rank = at === -1 ? null : at + 1
  return {
    id: question.id ?? `q${index + 1}`,
    question: question.question,
    hit: rank !== null && rank <= k,
    rank,
    top: results.slice(0, k),
    error: null,
    degraded,
  }
}

export interface EvalSummary {
  k: number
  total: number
  hits: number
  /** hits / total, 0..1. */
  hitAtK: number
  /** Mean reciprocal rank over all returned results (0 for misses). */
  mrr: number
  errors: number
  degraded: number
}

export function summarize(scores: readonly QuestionScore[], k: number): EvalSummary {
  const total = scores.length
  const hits = scores.filter((score) => score.hit).length
  const mrr = total === 0 ? 0 : scores.reduce((sum, score) => sum + (score.rank === null ? 0 : 1 / score.rank), 0) / total
  return {
    k,
    total,
    hits,
    hitAtK: total === 0 ? 0 : hits / total,
    mrr,
    errors: scores.filter((score) => score.error !== null).length,
    degraded: scores.filter((score) => score.degraded).length,
  }
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`

/** Plain-text report: one line per question, then the score. */
export function formatReport(scores: readonly QuestionScore[], summary: EvalSummary): string {
  const lines: string[] = []
  for (const score of scores) {
    const mark = score.error !== null ? 'ERR ' : score.hit ? 'HIT ' : 'MISS'
    const rank = score.error !== null ? score.error : score.rank === null ? 'not returned' : `rank ${score.rank}`
    lines.push(`${mark}  ${score.id}  ${score.question}`)
    lines.push(`      ${rank}${score.degraded ? ' (full text only: embedding failed)' : ''}`)
    if (!score.hit && score.error === null) {
      score.top.forEach((doc, i) => lines.push(`      ${i + 1}. ${doc.source.kind}:${doc.source.name}  ${doc.path}`))
    }
  }
  lines.push('')
  lines.push(`hit@${summary.k}: ${summary.hits}/${summary.total} = ${pct(summary.hitAtK)}   MRR: ${summary.mrr.toFixed(3)}`)
  if (summary.errors > 0) lines.push(`${summary.errors} question(s) failed to run`)
  if (summary.degraded > 0) lines.push(`${summary.degraded} question(s) ran on full text only (Ollama unavailable)`)
  return lines.join('\n')
}

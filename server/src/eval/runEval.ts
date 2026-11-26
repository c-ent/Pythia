import type { SearchService } from '../search/searchService.js'
import {
  EXPECTED_QUESTION_COUNT,
  scoreQuestion,
  summarize,
  type EvalSet,
  type EvalSummary,
  type QuestionScore,
  type RankedDoc,
} from './evalSet.js'

/** How many chunks to ask for, so the rank of a miss outside the top k is still known. */
export const EVAL_SEARCH_LIMIT = 50

export interface EvalRun {
  scores: QuestionScore[]
  summary: EvalSummary
  warnings: string[]
}

export interface RunEvalOptions {
  k?: number
  /** Called after each question, for progress output. */
  onQuestion?: (score: QuestionScore, index: number, total: number) => void
}

/**
 * Runs every question through the same search the web app and MCP use and
 * scores it. Search returns chunks; results are collapsed to one per document
 * (its best chunk) before ranking, because a question asks for a note, not a
 * section of one. Questions run one at a time so the embedder is not flooded.
 */
export async function runEval(search: SearchService, set: EvalSet, options: RunEvalOptions = {}): Promise<EvalRun> {
  const k = options.k ?? 5
  const warnings: string[] = []
  if (set.questions.length !== EXPECTED_QUESTION_COUNT) {
    warnings.push(`The set has ${set.questions.length} questions; the baseline is meant to use ${EXPECTED_QUESTION_COUNT}.`)
  }
  const ids = new Set<string>()
  set.questions.forEach((question, i) => {
    const id = question.id ?? `q${i + 1}`
    if (ids.has(id)) warnings.push(`Question id ${id} is used more than once.`)
    ids.add(id)
  })

  const scores: QuestionScore[] = []
  for (const [i, question] of set.questions.entries()) {
    let score: QuestionScore
    try {
      const response = await search.search({
        query: question.question,
        limit: EVAL_SEARCH_LIMIT,
        ...(question.sources === undefined ? {} : { sources: question.sources }),
      })
      score = scoreQuestion(question, i, uniqueDocuments(response.results), k, response.degraded)
    } catch (error) {
      score = {
        ...scoreQuestion(question, i, [], k),
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'search failed',
      }
    }
    scores.push(score)
    options.onQuestion?.(score, i, set.questions.length)
  }
  return { scores, summary: summarize(scores, k), warnings }
}

function uniqueDocuments(results: ReadonlyArray<RankedDoc & { documentId: number }>): RankedDoc[] {
  const seen = new Set<number>()
  const docs: RankedDoc[] = []
  for (const result of results) {
    if (seen.has(result.documentId)) continue
    seen.add(result.documentId)
    docs.push({ source: result.source, path: result.path, title: result.title })
  }
  return docs
}

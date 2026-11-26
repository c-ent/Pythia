import { describe, expect, it } from 'vitest'
import type { SearchResponse, SearchResult, SearchService } from '../search/searchService.js'
import { formatReport, matches, parseEvalSet, scoreQuestion, summarize, type EvalSet } from './evalSet.js'
import { runEval } from './runEval.js'

const hit = (documentId: number, path: string, kind = 'obsidian', name = 'vault'): SearchResult =>
  ({
    chunkId: documentId * 10,
    documentId,
    source: { kind, name },
    path,
    title: path,
    headingPath: '',
    startLine: null,
    endLine: null,
    allowLlm: true,
    score: 1,
    ftsRank: null,
    vectorRank: null,
    snippet: { text: '', highlights: [] },
  }) as SearchResult

function fakeSearch(answers: Record<string, SearchResponse | Error>): SearchService & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    async search(request) {
      calls.push(request)
      const answer = answers[request.query]
      if (answer === undefined) return { results: [], degraded: false }
      if (answer instanceof Error) throw answer
      return answer
    },
    getDocument: () => Promise.resolve(null),
    findDocument: () => Promise.resolve(null),
    recent: () => Promise.resolve([]),
  }
}

describe('parseEvalSet', () => {
  it('reads a valid set', () => {
    const set = parseEvalSet(JSON.stringify({ questions: [{ question: ' q ', expected: [{ path: 'a.md' }] }] }))
    expect(set.questions[0]!.question).toBe('q')
  })

  it('names the first problem in a bad file', () => {
    expect(() => parseEvalSet('{')).toThrow('not valid JSON')
    expect(() => parseEvalSet(JSON.stringify({ questions: [{ question: 'q', expected: [] }] }))).toThrow(
      /questions\.0\.expected/,
    )
    expect(() =>
      parseEvalSet(JSON.stringify({ questions: [{ question: 'q', expected: [{ path: 'a', kind: 'work' }] }] })),
    ).toThrow(/kind/)
  })
})

describe('matches', () => {
  const doc = { source: { kind: 'repo', name: 'pythia' }, path: 'src/App.tsx', title: 'App.tsx' }

  it('compares paths without case or slash differences', () => {
    expect(matches(doc, { path: './SRC\\app.tsx' })).toBe(true)
    expect(matches(doc, { path: 'src/other.tsx' })).toBe(false)
  })

  it('checks kind and name when given', () => {
    expect(matches(doc, { path: 'src/App.tsx', kind: 'repo', name: 'pythia' })).toBe(true)
    expect(matches(doc, { path: 'src/App.tsx', kind: 'obsidian' })).toBe(false)
    expect(matches(doc, { path: 'src/App.tsx', name: 'other' })).toBe(false)
  })
})

describe('scoring', () => {
  const question = { question: 'q', expected: [{ path: 'b.md' }, { path: 'z.md' }] }
  const docs = ['a.md', 'x.md', 'y.md', 'w.md', 'v.md', 'b.md'].map((path) => ({
    source: { kind: 'obsidian', name: 'vault' },
    path,
    title: path,
  }))

  it('records the rank of the first expected document and hits only within k', () => {
    expect(scoreQuestion(question, 0, docs, 5)).toMatchObject({ id: 'q1', hit: false, rank: 6 })
    expect(scoreQuestion(question, 0, docs, 6)).toMatchObject({ hit: true, rank: 6 })
    expect(scoreQuestion(question, 2, [], 5)).toMatchObject({ id: 'q3', hit: false, rank: null, top: [] })
  })

  it('summarizes hit@k and MRR', () => {
    const scores = [
      scoreQuestion(question, 0, docs.slice(5), 5),
      scoreQuestion(question, 1, docs.slice(4), 5),
      scoreQuestion(question, 2, [], 5),
      scoreQuestion(question, 3, docs.slice(1), 5),
    ]
    const summary = summarize(scores, 5)
    expect(summary).toMatchObject({ k: 5, total: 4, hits: 3, hitAtK: 0.75, errors: 0 })
    expect(summary.mrr).toBeCloseTo((1 + 1 / 2 + 0 + 1 / 5) / 4)
    const report = formatReport(scores, summary)
    expect(report).toContain('hit@5: 3/4 = 75.0%')
    expect(report).toContain('MISS  q3  q')
  })
})

describe('runEval', () => {
  const set: EvalSet = {
    questions: [
      { id: 'garden', question: 'garden', expected: [{ path: 'Garden.md' }] },
      { id: 'repo', question: 'login', expected: [{ path: 'src/auth.ts', kind: 'repo' }], sources: ['repo'] },
      { id: 'broken', question: 'broken', expected: [{ path: 'x.md' }] },
    ],
  }

  it('collapses chunks to documents, passes source filters and survives a failed search', async () => {
    const search = fakeSearch({
      // Five chunks of one document must not push the expected one out of the top 5.
      garden: {
        results: [1, 1, 1, 1, 1].map((id) => hit(id, 'Other.md')).concat(hit(2, 'Garden.md')),
        degraded: false,
      },
      login: { results: [hit(3, 'src/auth.ts', 'repo', 'kitchen-app')], degraded: true },
      broken: new Error('database down'),
    })
    const run = await runEval(search, set)
    expect(run.scores.map((score) => [score.id, score.hit, score.rank])).toEqual([
      ['garden', true, 2],
      ['repo', true, 1],
      ['broken', false, null],
    ])
    expect(run.scores[1]!.degraded).toBe(true)
    expect(run.scores[2]!.error).toBe('Error: database down')
    expect(run.summary).toMatchObject({ hits: 2, total: 3, errors: 1, degraded: 1 })
    expect(search.calls[1]).toMatchObject({ query: 'login', sources: ['repo'] })
    expect(run.warnings).toEqual(['The set has 3 questions; the baseline is meant to use 30.'])
  })

  it('warns about duplicate ids', async () => {
    const run = await runEval(fakeSearch({}), {
      questions: [
        { id: 'a', question: 'one', expected: [{ path: 'a.md' }] },
        { id: 'a', question: 'two', expected: [{ path: 'b.md' }] },
      ],
    })
    expect(run.warnings).toContain('Question id a is used more than once.')
  })
})

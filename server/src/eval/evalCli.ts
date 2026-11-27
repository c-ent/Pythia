import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createPool } from '../db/pool.js'
import { loadConfig } from '../config.js'
import { createPgSearchStore } from '../db/searchStore.js'
import { createOllamaEmbedder } from '../embed/ollama.js'
import { createSearchService } from '../search/searchService.js'
import { formatReport, parseEvalSet } from './evalSet.js'
import { runEval } from './runEval.js'

/**
 * `pnpm --filter server eval [file] [--k 5] [--save]` (T23). Runs the owner's
 * evaluation questions against the live index and prints per-question results
 * and the hit@k score. `--save` records the run as a JSON baseline under
 * `data/eval/` (gitignored, like the questions: both name private notes).
 */

const DEFAULT_FILE = path.join('data', 'eval', 'questions.json')

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { k: { type: 'string', default: '5' }, save: { type: 'boolean', default: false } },
})

const k = Number(values.k)
if (!Number.isInteger(k) || k < 1 || k > 50) {
  console.error('--k must be a whole number from 1 to 50')
  process.exit(2)
}

// pnpm runs package scripts in server/; paths are relative to the repo root.
const root = path.resolve(import.meta.dirname, '..', '..', '..')
const file = path.resolve(root, positionals[0] ?? DEFAULT_FILE)

let text: string
try {
  text = await readFile(file, 'utf8')
} catch {
  console.error(`No evaluation file at ${file}. Copy server/eval.example.json there and write your questions.`)
  process.exit(2)
}

const set = parseEvalSet(text)
const config = loadConfig(process.env)
const pool = createPool(config.db)

try {
  // Same settings as the server's query embedder, so scores match what the app sees.
  const search = createSearchService({
    store: createPgSearchStore(pool),
    embedder: createOllamaEmbedder({ baseUrl: config.ollamaUrl, timeoutMs: 10_000, retries: 0 }),
    log: () => {},
  })
  const run = await runEval(search, set, {
    k,
    onQuestion: (_score, i, total) => process.stderr.write(`\r${i + 1}/${total}`),
  })
  process.stderr.write('\n')
  for (const warning of run.warnings) console.warn(`warning: ${warning}`)
  console.log(formatReport(run.scores, run.summary))

  if (values.save) {
    const dir = path.join(root, 'data', 'eval')
    await mkdir(dir, { recursive: true })
    const at = new Date().toISOString()
    const out = path.join(dir, `results-${at.replace(/[:.]/g, '-')}.json`)
    await writeFile(out, `${JSON.stringify({ at, file: path.relative(root, file), ...run }, null, 2)}\n`)
    console.log(`saved ${path.relative(root, out)}`)
  }
} finally {
  await pool.end()
}

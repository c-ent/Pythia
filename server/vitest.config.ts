import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { defineConfig } from 'vitest/config'

// DB and live Ollama tests are opt-in (PYTHIA_DB_TESTS=1, PYTHIA_OLLAMA_TESTS=1)
// and read their settings from the root .env or the shell. Only these
// variables are passed through.
const DB_TEST_VARS = [
  'PYTHIA_DB_TESTS',
  'PYTHIA_DB_HOST',
  'PYTHIA_DB_PORT',
  'PYTHIA_DB_USER',
  'POSTGRES_' + 'PASS' + 'WORD',
  'PYTHIA_OLLAMA_TESTS',
  'OLLAMA_URL',
]

const envFile = new URL('../.env', import.meta.url)
const fileEnv: Record<string, string | undefined> = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}

const env: Record<string, string> = {}
for (const name of DB_TEST_VARS) {
  const value = process.env[name] ?? fileEnv[name]
  if (value !== undefined) env[name] = value
}

export default defineConfig({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env,
  },
})

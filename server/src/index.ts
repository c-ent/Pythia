import { createServer } from 'node:http'
import pg from 'pg'
import { createApp } from './app.js'
import { createAskService } from './ask/askService.js'
import { createGeminiModel } from './ask/gemini.js'
import { createOllamaChatModel } from './ask/ollamaChat.js'
import { loadConfig } from './config.js'
import { createPgChunkTextLoader, createPgSearchStore } from './db/searchStore.js'
import { createOllamaEmbedder } from './embed/ollama.js'
import { startRepos, type RunningRepos } from './ingest/startRepos.js'
import { startVault, type RunningVault } from './ingest/startVault.js'
import { createAuthDeps } from './routes/auth.js'
import { createSearchService } from './search/searchService.js'
import { createPgSyncStore } from './db/syncStore.js'
import { createPgRepoStore } from './db/repoStore.js'
import { createPgIndexStore, ensureSource } from './db/indexStore.js'
import { createPgStatusStore } from './db/statusStore.js'
import { createPgLlmExclusionStore } from './db/llmExclusionStore.js'
import { createPgProfileStore } from './db/profileStore.js'
import { createProfileService } from './profile/profileService.js'
import { createPgRecentQueryStore } from './db/recentQueryStore.js'
import { createRecentQueryService } from './recent/recentQueryService.js'
import { createSettingsService } from './settings/settingsService.js'
import { createImportService } from './ingest/importService.js'
import { createRepoService } from './search/repoService.js'
import { createSyncService } from './sync/syncService.js'

const config = loadConfig(process.env)
const pool = new pg.Pool(config.db)

// Search waits on the query embedding, so it gets a short timeout and no
// retries; on failure the search service falls back to full text only.
const queryEmbedder = createOllamaEmbedder({ baseUrl: config.ollamaUrl, timeoutMs: 10_000, retries: 0 })
const search = createSearchService({ store: createPgSearchStore(pool), embedder: queryEmbedder })
// Indexing (vault, repos, Keep) can wait; batch size and timeout come from
// PYTHIA_EMBED_BATCH_SIZE / PYTHIA_EMBED_TIMEOUT_MS for slow CPU-only hosts.
const indexEmbedder = () =>
  createOllamaEmbedder({ baseUrl: config.ollamaUrl, batchSize: config.embed.batchSize, timeoutMs: config.embed.timeoutMs })
console.log(`embed: indexing batches of ${config.embed.batchSize}, timeout ${config.embed.timeoutMs} ms`)
// Ask (R8): Gemini only with a key; the local model unless OLLAMA_CHAT_MODEL is empty.
const ask = createAskService({
  search,
  chunks: createPgChunkTextLoader(pool),
  gemini:
    config.ask.geminiApiKey === null
      ? null
      : createGeminiModel({ apiKey: config.ask.geminiApiKey, model: config.ask.geminiModel }),
  local:
    config.ask.ollamaChatModel === null
      ? null
      : createOllamaChatModel({ baseUrl: config.ollamaUrl, model: config.ask.ollamaChatModel }),
})
console.log(
  `ask: gemini ${config.ask.geminiApiKey === null ? 'off (no GEMINI_API_KEY)' : config.ask.geminiModel}, ` +
    `local ${config.ask.ollamaChatModel ?? 'off'}`,
)
const auth = createAuthDeps(config.auth)
const sync = createSyncService({ store: createPgSyncStore(pool) })
const repoService = createRepoService({ store: createPgRepoStore(pool) })

// The Gemini exclusion list (R3, T24), edited under Settings. Empty by default.
const llmExclusions = createPgLlmExclusionStore(pool)

let vault: RunningVault | undefined
if (config.vault === null) {
  console.log('PYTHIA_VAULT_PATH is not set; vault indexing is off')
} else {
  vault = await startVault(pool, config.vault, indexEmbedder(), llmExclusions)
}

const settings = createSettingsService({
  exclusions: llmExclusions,
  ...(vault?.refreshAllowLlm === undefined ? {} : { refreshAllowLlm: vault.refreshAllowLlm }),
})

let repos: RunningRepos | undefined
if (config.repos === null) {
  console.log('PYTHIA_REPOS_CONFIG is not set; repo fetching is off')
} else {
  repos = await startRepos(pool, config.repos, indexEmbedder())
}

// Keep import (R12) and the Import page's status and re-index button.
const imports = createImportService({
  status: createPgStatusStore(pool),
  keepSource: () => ensureSource(pool, 'keep', 'keep', 'takeout'),
  store: createPgIndexStore(pool),
  embedder: indexEmbedder(),
  reindexers: { vault: vault?.rescan, repos: repos?.runNow },
})
console.log(config.webDir === null ? 'PYTHIA_WEB_DIR is not set; serving the API only' : `web: ${config.webDir}`)
const server = createServer(
  createApp({
    search,
    ask,
    auth,
    sync,
    repos: repoService,
    imports,
    settings,
    profile: createProfileService(createPgProfileStore(pool)),
    recent: createRecentQueryService(createPgRecentQueryStore(pool)),
    ...(config.webDir === null ? {} : { webDir: config.webDir }),
  }),
)

server.listen(config.port, config.host, () => {
  console.log(`pythia listening on http://${config.host}:${config.port}`)
})

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  server.close()
  void (async () => {
    await vault?.close()
    await repos?.close()
    await pool.end()
    process.exit(0)
  })()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

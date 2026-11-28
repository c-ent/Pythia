import { createServer } from 'node:http'
import { createPool } from './db/pool.js'
import { createApp } from './app.js'
import { createAskService } from './ask/askService.js'
import { createPgGeminiKeyStore, createPgGeminiUsageStore } from './db/geminiStore.js'
import { createGeminiSettings } from './settings/geminiSettings.js'
import { createOllamaChatModel } from './ask/ollamaChat.js'
import { loadConfig } from './config.js'
import { createPgChunkTextLoader, createPgSearchStore } from './db/searchStore.js'
import { createEmbedGate } from './embed/embedGate.js'
import { createOllamaEmbedder } from './embed/ollama.js'
import { startDrive, type RunningDrive } from './ingest/startDrive.js'
import { startRepos, type RunningRepos } from './ingest/startRepos.js'
import { startVault, type RunningVault } from './ingest/startVault.js'
import { createAuthDeps } from './routes/auth.js'
import { createSearchService } from './search/searchService.js'
import { createPgSyncStore } from './db/syncStore.js'
import { createPgRepoStore } from './db/repoStore.js'
import { createPgIndexStore, ensureSource } from './db/indexStore.js'
import { backfillDocumentVectors } from './db/documentVectorStore.js'
import { createPgRelatedStore, refreshNeighbours } from './db/neighbourStore.js'
import { createNeighbourRefresher, refreshAfterRounds } from './search/neighbourRefresh.js'
import { createRelatedService } from './search/relatedService.js'
import { createPgBacklinkStore } from './db/linkStore.js'
import { createBacklinkService } from './search/backlinkService.js'
import { createPgGraphStore } from './db/graphStore.js'
import { createPgTopicMapStore } from './db/topicMapStore.js'
import { createGraphService } from './search/graphService.js'
import { createTopicMapService } from './search/topicMapService.js'
import { createPgStatusStore } from './db/statusStore.js'
import { createPgLlmExclusionStore } from './db/llmExclusionStore.js'
import { createPgProfileStore } from './db/profileStore.js'
import { createProfileService } from './profile/profileService.js'
import { createPgRecentQueryStore } from './db/recentQueryStore.js'
import { createPgSessionStore } from './db/sessionStore.js'
import { createPgMcpTokenStore } from './db/mcpTokenStore.js'
import { createRecentQueryService } from './recent/recentQueryService.js'
import { createSettingsService } from './settings/settingsService.js'
import { createImportService } from './ingest/importService.js'
import { createRepoService } from './search/repoService.js'
import { createSyncService } from './sync/syncService.js'
import { createPgActivityStore } from './db/activityStore.js'
import { createActivityLog } from './sync/activity.js'
import { createStatusService } from './sync/statusService.js'
import { createSyncNow } from './sync/syncNow.js'
import { createHostMetrics } from './health/hostMetrics.js'
import { createConnectionChecks } from './health/connectionChecks.js'
import { combineOverallHealth, createOciClient, createOracleUsage } from './health/oci/index.js'

const config = loadConfig(process.env)
// A dropped Postgres connection is logged and reconnected, never fatal (T53).
const pool = createPool(config.db)

// Map vectors (R20, T65) for documents indexed before `document_vectors`
// existed, from their stored chunk embeddings: no Ollama call. New and
// changed documents get theirs in IndexStore.replaceDocument.
try {
  const backfilled = await backfillDocumentVectors(pool)
  if (backfilled > 0) console.log(`map: ${backfilled} document vectors backfilled`)
} catch (error) {
  console.error(`map: document vector backfill failed (${error instanceof Error ? error.name : 'unknown'})`)
}

// Every embed request goes through one gate, queries first (T51): a search
// waits for the one index request already running at most, never for a queue
// of batches.
const embedGate = createEmbedGate()
// Search waits on the query embedding, so it gets a short timeout (counting the
// wait at the gate) and no retries; on failure the search service falls back
// to full text only.
const queryEmbedder = createOllamaEmbedder({
  baseUrl: config.ollamaUrl,
  timeoutMs: 10_000,
  retries: 0,
  gate: embedGate,
  priority: 'query',
})
const search = createSearchService({ store: createPgSearchStore(pool), embedder: queryEmbedder })
// Indexing (vault, repos, Keep) can wait; batch size and timeout come from
// PYTHIA_EMBED_BATCH_SIZE / PYTHIA_EMBED_TIMEOUT_MS for slow CPU-only hosts.
// One text per request, so the request a search waits behind is a single chunk.
const indexEmbedder = () =>
  createOllamaEmbedder({
    baseUrl: config.ollamaUrl,
    batchSize: config.embed.batchSize,
    timeoutMs: config.embed.timeoutMs,
    gate: embedGate,
    priority: 'index',
    turnSize: 1,
  })
console.log(`embed: indexing batches of ${config.embed.batchSize}, timeout ${config.embed.timeoutMs} ms`)
// Gemini key (R16, T39): GEMINI_API_KEY in .env wins; otherwise the key saved
// in Settings, encrypted with PYTHIA_SECRETS_KEY. Every Gemini request is counted per day.
const gemini = createGeminiSettings({
  envKey: config.ask.geminiApiKey,
  secretsKey: config.secretsKey,
  geminiModel: config.ask.geminiModel,
  keys: createPgGeminiKeyStore(pool),
  usage: createPgGeminiUsageStore(pool),
})
// Ask (R8): Gemini only with a key, looked up per question so a key saved in
// Settings applies at once; the local model unless OLLAMA_CHAT_MODEL is empty.
const ask = createAskService({
  search,
  chunks: createPgChunkTextLoader(pool),
  gemini: () => gemini.model(),
  local:
    config.ask.ollamaChatModel === null
      ? null
      : createOllamaChatModel({ baseUrl: config.ollamaUrl, model: config.ask.ollamaChatModel }),
})
console.log(
  `ask: gemini ${config.ask.geminiApiKey === null ? 'key from Settings if saved' : `${config.ask.geminiModel} (GEMINI_API_KEY)`}, ` +
    `local ${config.ask.ollamaChatModel ?? 'off'}`,
)
if (config.secretsKey === null) console.log('PYTHIA_SECRETS_KEY is not set; a Gemini key cannot be saved in Settings')
// Web sessions live in the `sessions` table (T36), so signing a device out survives a restart.
// A rotated MCP token's hash lives in `mcp_token` (T37); until then PYTHIA_MCP_TOKEN is used.
const auth = createAuthDeps({
  ...config.auth,
  sessionStore: createPgSessionStore(pool),
  mcpTokenStore: createPgMcpTokenStore(pool),
})
const sync = createSyncService({ store: createPgSyncStore(pool) })
const repoService = createRepoService({ store: createPgRepoStore(pool) })

// The Gemini exclusion list (R3, T24), edited under Settings. Empty by default.
const llmExclusions = createPgLlmExclusionStore(pool)
// Semantic neighbours (R20, T66): refreshed from stored vectors after every
// index round (each round ends with an activity event), and once now for
// documents indexed or backfilled before this start. Never waits on Ollama.
const neighbours = createNeighbourRefresher(() => refreshNeighbours(pool))
neighbours.request()
// Sync activity (R18, T42): the last 50 events, counts and error classes only.
const activity = refreshAfterRounds(createActivityLog(createPgActivityStore(pool)), neighbours)

let vault: RunningVault | undefined
if (config.vault === null) {
  console.log('PYTHIA_VAULT_PATH is not set; vault indexing is off')
} else {
  vault = await startVault(pool, config.vault, indexEmbedder(), llmExclusions, activity)
}

const settings = createSettingsService({
  exclusions: llmExclusions,
  ...(vault?.refreshAllowLlm === undefined ? {} : { refreshAllowLlm: vault.refreshAllowLlm }),
})

let repos: RunningRepos | undefined
if (config.repos === null) {
  console.log('PYTHIA_REPOS_CONFIG is not set; repo fetching is off')
} else {
  repos = await startRepos(pool, config.repos, indexEmbedder(), llmExclusions, activity)
}

// Google Drive (R19, T61): rclone pull of My Drive, then the indexer, at
// startup, every 30 minutes and on Sync now.
let drive: RunningDrive | undefined
if (config.drive === null) {
  console.log('PYTHIA_DRIVE_REMOTE is not set; Drive is off')
} else {
  drive = await startDrive(pool, config.drive, indexEmbedder(), activity, { exclusions: llmExclusions })
}

// Keep import (R12) and the Import page's status and re-index button.
const imports = createImportService({
  status: createPgStatusStore(pool),
  keepSource: () => ensureSource(pool, 'keep', 'keep', 'takeout'),
  store: createPgIndexStore(pool),
  embedder: indexEmbedder(),
  exclusions: () => llmExclusions.list(),
  reindexers: { vault: vault?.rescan, repos: repos?.runNow },
  activity,
})
// Status, Sync now and per-repo re-sync (R18, T42).
const syncNow = createSyncNow({
  vault: vault?.rescan,
  repos: repos?.runNow,
  repo: repos?.runOne,
  drive: drive?.runNow,
})
const status = createStatusService({
  sources: createPgStatusStore(pool),
  activity,
  devices: async () => (await auth.login?.sessions.list())?.length ?? 0,
  gemini: () => gemini.available(),
  vault: vault?.rescan === undefined ? null : { watching: vault.watching },
  repos:
    repos === undefined ? null : { names: repos.names, intervalMs: repos.intervalMs, configError: repos.configError },
  syncing: () => syncNow.state(),
  // The startup round and the 30-minute rounds show as syncing too, not only Sync now (T52).
  ...(repos?.state === undefined ? {} : { repoRound: repos.state }),
  drive: drive?.runNow === undefined ? null : { intervalMs: drive.intervalMs },
  ...(drive?.state === undefined ? {} : { driveRound: drive.state }),
})
console.log(config.webDir === null ? 'PYTHIA_WEB_DIR is not set; serving the API only' : `web: ${config.webDir}`)
const related = createRelatedService({ store: createPgRelatedStore(pool) })
const backlinks = createBacklinkService({ store: createPgBacklinkStore(pool) })
const graph = createGraphService({ store: createPgGraphStore(pool) })
const topicMap = createTopicMapService({ store: createPgTopicMapStore(pool), embedder: queryEmbedder })
const hostMetrics = createHostMetrics(pool, {
  appVersion: '0.0.0',
  commit: process.env.PYTHIA_GIT_COMMIT ?? null,
})
const oci = createOciClient(config.oci)
const oracleUsage = createOracleUsage(oci, config.oci?.tenancyId ?? null)
const connectionChecks = createConnectionChecks({
  pool,
  ollamaUrl: config.ollamaUrl,
  gemini,
  githubToken: config.githubToken,
  vaultPath: config.vaultPath,
  status,
  oci,
})
const health = {
  health: async () => combineOverallHealth((await connectionChecks.read()).health, oracleUsage.snapshot()),
}
const serverHealth = {
  read: () => hostMetrics.read(),
  health: () => connectionChecks.read(),
  oracle: () => oracleUsage.snapshot(),
}
const server = createServer(
  createApp({
    search,
    ask,
    auth,
    sync,
    repos: repoService,
    imports,
    settings,
    gemini,
    profile: createProfileService(createPgProfileStore(pool)),
    recent: createRecentQueryService(createPgRecentQueryStore(pool)),
    status: { service: status, sync: syncNow, health },
    related,
    backlinks,
    graph,
    topicMap,
    hostMetrics: serverHealth,
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
    await syncNow.idle()
    await vault?.close()
    await repos?.close()
    await drive?.close()
    await neighbours.idle()
    oracleUsage.close()
    hostMetrics.close()
    await pool.end()
    process.exit(0)
  })()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

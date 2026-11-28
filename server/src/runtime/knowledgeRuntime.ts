import type { Pool } from 'pg'
import type { AppDeps } from '../app.js'
import { createAskService } from '../ask/askService.js'
import { createOllamaChatModel } from '../ask/ollamaChat.js'
import type { Config } from '../config.js'
import { createPgActivityStore } from '../db/activityStore.js'
import { backfillDocumentVectors } from '../db/documentVectorStore.js'
import { createPgGeminiKeyStore, createPgGeminiUsageStore } from '../db/geminiStore.js'
import { createPgGraphStore } from '../db/graphStore.js'
import { createPgIndexStore, ensureSource } from '../db/indexStore.js'
import { createPgBacklinkStore } from '../db/linkStore.js'
import { createPgLlmExclusionStore, readPgLlmExclusionCatalog } from '../db/llmExclusionStore.js'
import { createPgMcpTokenStore } from '../db/mcpTokenStore.js'
import { createPgRelatedStore, refreshNeighbours } from '../db/neighbourStore.js'
import { createPgProfileStore } from '../db/profileStore.js'
import { createPgRecentQueryStore } from '../db/recentQueryStore.js'
import { createPgRepoStore } from '../db/repoStore.js'
import { createPgAskContextLoader, createPgChunkTextLoader, createPgSearchStore } from '../db/searchStore.js'
import { createPgSessionStore } from '../db/sessionStore.js'
import { createPgStatusStore } from '../db/statusStore.js'
import { createPgSyncStore } from '../db/syncStore.js'
import { createPgTopicMapStore } from '../db/topicMapStore.js'
import { createEmbedGate } from '../embed/embedGate.js'
import { createOllamaEmbedder } from '../embed/ollama.js'
import { createImportService } from '../ingest/importService.js'
import { startDrive, type RunningDrive } from '../ingest/startDrive.js'
import { startRepos, type RunningRepos } from '../ingest/startRepos.js'
import { startVault, type RunningVault } from '../ingest/startVault.js'
import { createProfileService } from '../profile/profileService.js'
import { createRecentQueryService } from '../recent/recentQueryService.js'
import { createAuthDeps } from '../routes/auth.js'
import { createBacklinkService } from '../search/backlinkService.js'
import { createGraphService } from '../search/graphService.js'
import { createNeighbourRefresher, refreshAfterRounds } from '../search/neighbourRefresh.js'
import { createRelatedService } from '../search/relatedService.js'
import { createRepoService } from '../search/repoService.js'
import { createSearchService } from '../search/searchService.js'
import { createTopicMapService } from '../search/topicMapService.js'
import { createGeminiSettings, type GeminiSettingsService } from '../settings/geminiSettings.js'
import { createSettingsService } from '../settings/settingsService.js'
import { createActivityLog } from '../sync/activity.js'
import { createStatusService, type StatusService } from '../sync/statusService.js'
import { createSyncNow } from '../sync/syncNow.js'
import { createSyncService } from '../sync/syncService.js'

export interface KnowledgeRuntime {
  appDeps: Omit<AppDeps, 'hostMetrics' | 'webDir' | 'status'> & {
    status: { service: StatusService; sync: ReturnType<typeof createSyncNow> }
  }
  gemini: GeminiSettingsService
  status: StatusService
  close(): Promise<void>
}

/**
 * Composes Pythia's knowledge stores, embed gate, indexers, search/ask/map
 * modules, and graceful shutdown behind a single runtime interface.
 */
export async function createKnowledgeRuntime({
  pool,
  config,
}: {
  pool: Pool
  config: Config
}): Promise<KnowledgeRuntime> {
  try {
    const backfilled = await backfillDocumentVectors(pool)
    if (backfilled > 0) console.log(`map: ${backfilled} document vectors backfilled`)
  } catch (error) {
    console.error(`map: document vector backfill failed (${error instanceof Error ? error.name : 'unknown'})`)
  }

  const embedGate = createEmbedGate()
  const queryEmbedder = createOllamaEmbedder({
    baseUrl: config.ollamaUrl,
    timeoutMs: 10_000,
    retries: 0,
    gate: embedGate,
    priority: 'query',
  })
  const search = createSearchService({ store: createPgSearchStore(pool), embedder: queryEmbedder })
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

  const gemini = createGeminiSettings({
    envKey: config.ask.geminiApiKey,
    secretsKey: config.secretsKey,
    geminiModel: config.ask.geminiModel,
    keys: createPgGeminiKeyStore(pool),
    usage: createPgGeminiUsageStore(pool),
  })
  const localChatModel =
    config.ask.ollamaChatModel === null
      ? null
      : createOllamaChatModel({ baseUrl: config.ollamaUrl, model: config.ask.ollamaChatModel })

  const ask = createAskService({
    search,
    chunks: createPgChunkTextLoader(pool),
    context: createPgAskContextLoader(pool),
    gemini: () => gemini.model(),
    local: localChatModel,
  })
  console.log(
    `ask: gemini ${config.ask.geminiApiKey === null ? 'key from Settings if saved' : `${config.ask.geminiModel} (GEMINI_API_KEY)`}, ` +
      `local ${config.ask.ollamaChatModel ?? 'off'}`,
  )
  if (config.secretsKey === null) console.log('PYTHIA_SECRETS_KEY is not set; a Gemini key cannot be saved in Settings')

  const auth = createAuthDeps({
    ...config.auth,
    sessionStore: createPgSessionStore(pool),
    mcpTokenStore: createPgMcpTokenStore(pool),
  })
  const sync = createSyncService({ store: createPgSyncStore(pool) })
  const repoService = createRepoService({ store: createPgRepoStore(pool) })
  const llmExclusions = createPgLlmExclusionStore(pool)

  const neighbours = createNeighbourRefresher(() => refreshNeighbours(pool))
  neighbours.request()
  const activity = refreshAfterRounds(createActivityLog(createPgActivityStore(pool)), neighbours)

  let vault: RunningVault | undefined
  if (config.vault === null) {
    console.log('PYTHIA_VAULT_PATH is not set; vault indexing is off')
  } else {
    vault = await startVault(pool, config.vault, indexEmbedder(), llmExclusions, activity)
  }

  const settings = createSettingsService({
    exclusions: llmExclusions,
    catalog: () => readPgLlmExclusionCatalog(pool),
    ...(vault?.refreshAllowLlm === undefined ? {} : { refreshAllowLlm: vault.refreshAllowLlm }),
  })

  let repos: RunningRepos | undefined
  if (config.repos === null) {
    console.log('PYTHIA_REPOS_CONFIG is not set; repo fetching is off')
  } else {
    repos = await startRepos(pool, config.repos, indexEmbedder(), llmExclusions, activity)
  }

  let drive: RunningDrive | undefined
  if (config.drive === null) {
    console.log('PYTHIA_DRIVE_REMOTE is not set; Drive is off')
  } else {
    drive = await startDrive(pool, config.drive, indexEmbedder(), activity, { exclusions: llmExclusions })
  }

  const imports = createImportService({
    status: createPgStatusStore(pool),
    keepSource: () => ensureSource(pool, 'keep', 'keep', 'takeout'),
    store: createPgIndexStore(pool),
    embedder: indexEmbedder(),
    exclusions: () => llmExclusions.list(),
    reindexers: { vault: vault?.rescan, repos: repos?.runNow },
    activity,
  })

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
    vault: vault?.rescan === undefined ? null : { watching: vault.watching, ...(vault.progress === undefined ? {} : { progress: vault.progress }) },
    repos:
      repos === undefined ? null : { names: repos.names, intervalMs: repos.intervalMs, configError: repos.configError },
    syncing: () => syncNow.state(),
    ...(repos?.state === undefined
      ? {}
      : { repoRound: () => ({ ...repos.state!(), ...(repos.progress === undefined ? {} : { progress: repos.progress() }) }) }),
    drive: drive?.runNow === undefined ? null : { intervalMs: drive.intervalMs },
    ...(drive?.state === undefined
      ? {}
      : { driveRound: () => ({ ...drive.state!(), ...(drive.progress === undefined ? {} : { progress: drive.progress() }) }) }),
  })

  const related = createRelatedService({ store: createPgRelatedStore(pool) })
  const backlinks = createBacklinkService({ store: createPgBacklinkStore(pool) })
  const graph = createGraphService({ store: createPgGraphStore(pool) })
  const topicMap = createTopicMapService({
    store: createPgTopicMapStore(pool),
    embedder: queryEmbedder,
    gemini: () => gemini.model(),
    local: localChatModel,
  })

  return {
    appDeps: {
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
      status: { service: status, sync: syncNow },
      related,
      backlinks,
      graph,
      topicMap,
    },
    gemini,
    status,
    async close() {
      await syncNow.idle()
      await vault?.close()
      await repos?.close()
      await drive?.close()
      await neighbours.idle()
    },
  }
}

import type { Pool } from 'pg'
import type { Config } from '../config.js'
import { createConnectionChecks } from '../health/connectionChecks.js'
import { createHostMetrics } from '../health/hostMetrics.js'
import { combineOverallHealth, createOciClient, createOracleUsage } from '../health/oci/index.js'
import { createStorageScan } from '../health/storageScan.js'
import type { ServerHealthService } from '../routes/serverStatus.js'
import type { GeminiSettingsService } from '../settings/geminiSettings.js'
import type { StatusService } from '../sync/statusService.js'

export interface HealthRuntime {
  health: { health(): Promise<'ok' | 'warning' | 'broken'> }
  serverHealth: ServerHealthService
  close(): void
}

/**
 * Composes host metrics, OCI usage, storage scanning, and connection checks
 * behind a single health runtime interface with a `close()` teardown.
 */
export function createHealthRuntime({
  pool,
  config,
  gemini,
  status,
  gitCommit = process.env.PYTHIA_GIT_COMMIT ?? null,
}: {
  pool: Pool
  config: Config
  gemini: Pick<GeminiSettingsService, 'available' | 'status'>
  status: StatusService
  gitCommit?: string | null
}): HealthRuntime {
  const hostMetrics = createHostMetrics(pool, {
    appVersion: '0.0.0',
    commit: gitCommit,
  })
  const oci = createOciClient(config.oci)
  const oracleUsage = createOracleUsage(oci, config.oci?.tenancyId ?? null)
  const storageScan = createStorageScan({
    pool,
    ollamaUrl: config.ollamaUrl,
    hostRoot: config.hostRoot,
    vaultPath: config.vaultPath,
    reposDir: config.repos?.mirrorsDir ?? null,
    driveDir: config.drive?.mirrorDir ?? null,
  })
  const connectionChecks = createConnectionChecks({
    pool,
    ollamaUrl: config.ollamaUrl,
    gemini,
    githubToken: config.githubToken,
    vaultPath: config.vaultPath,
    status,
    oci,
  })

  return {
    health: {
      health: async () => combineOverallHealth((await connectionChecks.read()).health, oracleUsage.snapshot()),
    },
    serverHealth: {
      read: () => hostMetrics.read(),
      health: () => connectionChecks.read(),
      oracle: () => oracleUsage.snapshot(),
      storage: () => storageScan.snapshot(),
      scanStorage: () => storageScan.scan(),
    },
    close() {
      storageScan.close()
      oracleUsage.close()
      hostMetrics.close()
    },
  }
}

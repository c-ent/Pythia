import express, { type Router } from 'express'
import type { HostMetrics } from '../health/hostMetrics.js'
import type { HealthSnapshot } from '../health/connectionChecks.js'
import { combineOverallHealth, OFF_ORACLE_USAGE, type OracleUsageSnapshot } from '../health/oci/index.js'
import { EMPTY_STORAGE_SCAN, type StorageScanSnapshot } from '../health/storageScan.js'

export interface HostMetricsService {
  read(): Promise<HostMetrics>
}

export interface ServerHealthService extends HostMetricsService {
  health(): Promise<HealthSnapshot>
  oracle?(): OracleUsageSnapshot
  storage?(): StorageScanSnapshot
  scanStorage?(): Promise<StorageScanSnapshot>
}

export function createServerStatusRouter(services: ServerHealthService): Router {
  const router = express.Router()
  router.get('/status/server', async (_req, res) => {
    res.set('cache-control', 'no-store')
    const [metrics, checks] = await Promise.all([services.read(), services.health()])
    const oracle = services.oracle?.() ?? OFF_ORACLE_USAGE
    const storage = services.storage?.() ?? EMPTY_STORAGE_SCAN
    const health = combineOverallHealth(checks.health, oracle)
    res.json({ ...metrics, ...checks, health, oracle, storage })
  })
  router.post('/status/server/scan', async (_req, res) => {
    res.set('cache-control', 'no-store')
    const storage = await (services.scanStorage?.() ?? Promise.resolve(EMPTY_STORAGE_SCAN))
    res.json(storage)
  })
  return router
}

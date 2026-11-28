import express, { type Router } from 'express'
import type { HostMetrics } from '../health/hostMetrics.js'
import type { HealthSnapshot } from '../health/connectionChecks.js'
import { combineOverallHealth, OFF_ORACLE_USAGE, type OracleUsageSnapshot } from '../health/oci/index.js'

export interface HostMetricsService {
  read(): Promise<HostMetrics>
}

export interface ServerHealthService extends HostMetricsService {
  health(): Promise<HealthSnapshot>
  oracle?(): OracleUsageSnapshot
}

export function createServerStatusRouter(services: ServerHealthService): Router {
  const router = express.Router()
  router.get('/status/server', async (_req, res) => {
    res.set('cache-control', 'no-store')
    const [metrics, checks] = await Promise.all([services.read(), services.health()])
    const oracle = services.oracle?.() ?? OFF_ORACLE_USAGE
    const health = combineOverallHealth(checks.health, oracle)
    res.json({ ...metrics, ...checks, health, oracle })
  })
  return router
}

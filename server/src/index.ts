import { createServer } from 'node:http'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createHealthRuntime } from './runtime/healthRuntime.js'
import { createKnowledgeRuntime } from './runtime/knowledgeRuntime.js'

const config = loadConfig(process.env)
// A dropped Postgres connection is logged and reconnected, never fatal (T53).
const pool = createPool(config.db)

const knowledge = await createKnowledgeRuntime({ pool, config })
console.log(config.webDir === null ? 'PYTHIA_WEB_DIR is not set; serving the API only' : `web: ${config.webDir}`)

const healthRuntime = createHealthRuntime({
  pool,
  config,
  gemini: knowledge.gemini,
  status: knowledge.status,
})

const server = createServer(
  createApp({
    ...knowledge.appDeps,
    status: { ...knowledge.appDeps.status, health: healthRuntime.health },
    hostMetrics: healthRuntime.serverHealth,
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
    await knowledge.close()
    healthRuntime.close()
    await pool.end()
    process.exit(0)
  })()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

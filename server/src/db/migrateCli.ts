import { createPool } from './pool.js'
import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'

const config = loadConfig(process.env)
const pool = createPool(config.db)

try {
  const { applied, skipped } = await runMigrations(pool)
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`)
} finally {
  await pool.end()
}

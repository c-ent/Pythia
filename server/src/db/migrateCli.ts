import pg from 'pg'
import { loadConfig } from '../config.js'
import { runMigrations } from './migrate.js'

const config = loadConfig(process.env)
const pool = new pg.Pool(config.db)

try {
  const { applied, skipped } = await runMigrations(pool)
  console.log(`migrations: ${applied.length} applied, ${skipped.length} already applied`)
} finally {
  await pool.end()
}

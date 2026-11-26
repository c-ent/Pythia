import { readdir, readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

// Resolves to server/migrations from both src/db (tsx) and dist/db (built).
export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url)

// Arbitrary constant shared by every runner so two app instances starting at
// once cannot apply the same migration twice.
const MIGRATION_LOCK_ID = 7_294_731

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

/** Migration files are `NNN_name.sql`, applied in name order. */
export function selectMigrationFiles(names: readonly string[]): string[] {
  return names.filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort()
}

/**
 * Applies every migration not yet recorded in `schema_migrations`, each in its
 * own transaction. Safe to run repeatedly.
 */
export async function runMigrations(pool: Pool, dir: URL = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = selectMigrationFiles(await readdir(dir))
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           name text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations')
      const done = new Set(rows.map((row) => row.name))
      const result: MigrationResult = { applied: [], skipped: [] }

      for (const file of files) {
        if (done.has(file)) {
          result.skipped.push(file)
          continue
        }
        const sql = await readFile(new URL(file, dir), 'utf8')
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
        result.applied.push(file)
      }
      return result
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
    }
  } finally {
    client.release()
  }
}

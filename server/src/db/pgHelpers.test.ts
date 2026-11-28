import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { sourceFilterSql, toVectorLiteral, visibleSource, withHnswScan } from './pgHelpers.js'

describe('pgHelpers', () => {
  it('formats visibility and source filter SQL consistently', () => {
    expect(visibleSource()).toBe("s.enabled AND s.kind <> 'work' AND NOT d.excluded")
    const filter = sourceFilterSql(3, 4)
    expect(filter).toContain('$3::text[] IS NULL')
    expect(filter).toContain('$4::text IS NULL')
  })

  it('formats pgvector literals', () => {
    expect(toVectorLiteral([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]')
  })

  it('runs HNSW queries in a transaction with clamped ef_search and releases the client', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const release = vi.fn()
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        return { rows: [] }
      }),
      release,
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    const result = await withHnswScan(pool, 40, async () => 'ok')

    expect(result).toBe('ok')
    expect(queries[0].sql).toBe('BEGIN')
    expect(queries[1].params).toEqual(['100'])
    expect(queries[2].sql).toBe('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and releases the client when the callback throws', async () => {
    const queries: string[] = []
    const release = vi.fn()
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql)
        return { rows: [] }
      }),
      release,
    }
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(
      withHnswScan(pool, 5000, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(queries[0]).toBe('BEGIN')
    expect(queries.at(-1)).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
  })
})

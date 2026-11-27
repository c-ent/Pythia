import type { Pool } from 'pg'
import type { McpTokenStore } from '../mcp/mcpToken.js'

interface McpTokenRow {
  token_hash: string
  last4: string
  rotated_at: Date
}

/** The single `mcp_token` row from migrations/007_mcp_token.sql. */
export function createPgMcpTokenStore(pool: Pool): McpTokenStore {
  return {
    async get() {
      const { rows } = await pool.query<McpTokenRow>('SELECT token_hash, last4, rotated_at FROM mcp_token WHERE id')
      const row = rows[0]
      return row === undefined ? null : { tokenHash: row.token_hash, last4: row.last4, rotatedAt: row.rotated_at }
    },

    async save(token) {
      await pool.query(
        `INSERT INTO mcp_token (id, token_hash, last4, rotated_at) VALUES (true, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, last4 = EXCLUDED.last4, rotated_at = EXCLUDED.rotated_at`,
        [token.tokenHash, token.last4, token.rotatedAt],
      )
    },
  }
}

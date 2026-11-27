import { sha256Hex } from '../security/session.js'
import { randomSecret, secretsEqual } from '../security/tokens.js'

/** The stored MCP token: its hash and last 4 characters, never the token. */
export interface StoredMcpToken {
  tokenHash: string
  last4: string
  rotatedAt: Date
}

export interface McpTokenStore {
  get(): Promise<StoredMcpToken | null>
  /** Replaces the stored token (there is at most one). */
  save(token: StoredMcpToken): Promise<void>
}

/** `env` until the first rotation, `database` after it, `none` when neither is set. */
export type McpTokenSource = 'env' | 'database' | 'none'

export interface McpTokenStatus {
  source: McpTokenSource
  last4: string | null
  /** When the database token was made; null for the `.env` token. */
  rotatedAt: Date | null
}

export interface RotatedMcpToken {
  /** Shown once, in the rotate response; never stored or logged. */
  token: string
  last4: string
  rotatedAt: Date
}

export interface McpTokenService {
  /** True when `given` is the token in use, compared in constant time. */
  verify(given: string): Promise<boolean>
  status(): Promise<McpTokenStatus>
  /** Makes a new token; the old one (from `.env` or a past rotation) stops working at once. */
  rotate(now?: number): Promise<RotatedMcpToken>
}

export interface McpTokenOptions {
  /** PYTHIA_MCP_TOKEN, used until the first rotation. */
  envToken: string | null
  store: McpTokenStore
}

const last4 = (token: string): string => token.slice(-4)

/**
 * MCP token rotation (T37). The store is read on every check, so a rotation
 * takes effect at once, also for other server instances.
 */
export function createMcpTokenService(options: McpTokenOptions): McpTokenService {
  const { envToken, store } = options
  return {
    async verify(given) {
      const stored = await store.get()
      if (stored !== null) return secretsEqual(sha256Hex(given), stored.tokenHash)
      return envToken !== null && secretsEqual(given, envToken)
    },

    async status() {
      const stored = await store.get()
      if (stored !== null) return { source: 'database', last4: stored.last4, rotatedAt: stored.rotatedAt }
      if (envToken !== null) return { source: 'env', last4: last4(envToken), rotatedAt: null }
      return { source: 'none', last4: null, rotatedAt: null }
    },

    async rotate(now = Date.now()) {
      const token = randomSecret(32)
      const rotatedAt = new Date(now)
      await store.save({ tokenHash: sha256Hex(token), last4: last4(token), rotatedAt })
      return { token, last4: last4(token), rotatedAt }
    },
  }
}

/** In-memory `McpTokenStore` for tests. */
export function createMemoryMcpTokenStore(): McpTokenStore & { stored(): StoredMcpToken | null } {
  let current: StoredMcpToken | null = null
  return {
    async get() {
      return current === null ? null : { ...current }
    },
    async save(token) {
      current = { ...token }
    },
    stored() {
      return current === null ? null : { ...current }
    },
  }
}

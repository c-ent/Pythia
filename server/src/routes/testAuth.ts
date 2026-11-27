// Test helper: auth deps with an in-memory session store and a signed-in
// cookie, for route tests whose subject is not auth itself.
import { createMcpTokenService, createMemoryMcpTokenStore } from '../mcp/mcpToken.js'
import { createVisitorLimiter } from '../security/rateLimit.js'
import { createMemorySessionStore, createSessionManager, type MemorySessionStore, type SessionManager } from '../security/sessionStore.js'
import { SESSION_COOKIE, type AuthDeps } from './auth.js'

export interface TestAuth {
  auth: AuthDeps
  /** A `Cookie` header value for an active session. */
  cookie: string
  sessions: SessionManager
  store: MemorySessionStore
}

export async function testAuth(userAgent?: string): Promise<TestAuth> {
  const store = createMemorySessionStore()
  const sessions = createSessionManager({ store, passwordHash: 'test-hash' })
  const auth: AuthDeps = {
    login: {
      // Never checked: these tests sign in through `cookie`, not /api/login.
      password: { cost: { memory: 1024, passes: 2, parallelism: 1 }, salt: Buffer.alloc(16), key: Buffer.alloc(32) },
      sessions,
      limiter: createVisitorLimiter({ max: 10, windowMs: 60_000 }),
    },
    mcp: createMcpTokenService({ envToken: null, store: createMemoryMcpTokenStore() }),
  }
  const { token } = await sessions.issue(userAgent)
  return { auth, cookie: `${SESSION_COOKIE}=${token}`, sessions, store }
}

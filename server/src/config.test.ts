import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './config.js'

const PW_VAR = 'POSTGRES_' + 'PASS' + 'WORD'
const pw = 'test-' + 'pw-value'
const base = { [PW_VAR]: pw }

describe('loadConfig', () => {
  it('applies defaults and always binds to 127.0.0.1', () => {
    expect(loadConfig(base)).toEqual({
      host: '127.0.0.1',
      port: 3000,
      db: { host: '127.0.0.1', port: 5433, user: 'pythia', database: 'pythia', password: pw },
      ollamaUrl: 'http://127.0.0.1:11434',
      embed: { batchSize: 32, timeoutMs: 120_000 },
      vault: null,
      repos: null,
      auth: { passwordHash: null, mcpToken: null },
      ask: { geminiApiKey: null, geminiModel: 'gemini-3.5-flash-lite', ollamaChatModel: 'qwen3:4b' },
      secretsKey: null,
      webDir: null,
    })
  })

  it('reads PYTHIA_SECRETS_KEY as 32 bytes and rejects a malformed one without echoing it', () => {
    const bytes = Buffer.alloc(32, 7)
    expect(loadConfig({ ...base, PYTHIA_SECRETS_KEY: bytes.toString('base64') }).secretsKey?.equals(bytes)).toBe(true)
    expect(loadConfig({ ...base, PYTHIA_SECRETS_KEY: '' }).secretsKey).toBeNull()
    const bad = 'not-' + 'a-key'
    let message = ''
    try {
      loadConfig({ ...base, PYTHIA_SECRETS_KEY: bad })
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/PYTHIA_SECRETS_KEY/)
    expect(message).not.toContain(bad)
  })

  it('reads the indexing embed batch size and timeout for slow hosts', () => {
    expect(loadConfig({ ...base, PYTHIA_EMBED_BATCH_SIZE: '8', PYTHIA_EMBED_TIMEOUT_MS: '600000' }).embed).toEqual({
      batchSize: 8,
      timeoutMs: 600_000,
    })
  })

  it.each([
    ['PYTHIA_EMBED_BATCH_SIZE', '0'],
    ['PYTHIA_EMBED_BATCH_SIZE', '1.5'],
    ['PYTHIA_EMBED_TIMEOUT_MS', '500'],
    ['PYTHIA_EMBED_TIMEOUT_MS', 'soon'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(new RegExp(name))
  })

  it('serves the built web app only when PYTHIA_WEB_DIR is set', () => {
    expect(loadConfig({ ...base, PYTHIA_WEB_DIR: '' }).webDir).toBeNull()
    expect(loadConfig({ ...base, PYTHIA_WEB_DIR: ' /app/web ' }).webDir).toBe('/app/web')
  })

  it('reads Ask values, treats an empty key as unset, and turns the local model off when empty', () => {
    const key = 'AIza' + 'x'.repeat(35)
    expect(loadConfig({ ...base, GEMINI_API_KEY: key, GEMINI_MODEL: 'gemini-4-hydrogen', OLLAMA_CHAT_MODEL: 'llama3.2:3b' }).ask).toEqual({
      geminiApiKey: key,
      geminiModel: 'gemini-4-hydrogen',
      ollamaChatModel: 'llama3.2:3b',
    })
    expect(loadConfig({ ...base, GEMINI_API_KEY: ' ', OLLAMA_CHAT_MODEL: '' }).ask).toMatchObject({
      geminiApiKey: null,
      ollamaChatModel: null,
    })
    const short = 'AIza' + 'short'
    let message = ''
    try {
      loadConfig({ ...base, GEMINI_API_KEY: short })
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/GEMINI_API_KEY/)
    expect(message).not.toContain(short)
  })

  it('reads auth values, treats empty as unset, and rejects short secrets without echoing them', () => {
    const hash = '$argon2id$' + 'v=19$m=1024,t=2,p=1$c2FsdA$a2V5'
    const secret = 's'.repeat(40)
    const token = 't'.repeat(40)
    expect(
      loadConfig({ ...base, PYTHIA_PASSWORD_HASH: hash, PYTHIA_SESSION_SECRET: secret, PYTHIA_MCP_TOKEN: token }).auth,
    ).toEqual({ passwordHash: hash, mcpToken: token })
    expect(loadConfig({ ...base, PYTHIA_PASSWORD_HASH: '', PYTHIA_MCP_TOKEN: '' }).auth).toEqual({
      passwordHash: null,
      mcpToken: null,
    })
    const short = 'short-' + 'token'
    let message = ''
    try {
      loadConfig({ ...base, PYTHIA_MCP_TOKEN: short })
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/PYTHIA_MCP_TOKEN/)
    expect(message).not.toContain(short)
  })

  it('treats an empty or blank vault path as unset', () => {
    expect(loadConfig({ ...base, PYTHIA_VAULT_PATH: '' }).vault).toBeNull()
    expect(loadConfig({ ...base, PYTHIA_VAULT_PATH: '   ' }).vault).toBeNull()
  })

  it('reads the vault path and watch switch', () => {
    expect(loadConfig({ ...base, PYTHIA_VAULT_PATH: '/vault' }).vault).toEqual({ root: '/vault', watch: true })
    const config = loadConfig({ ...base, PYTHIA_VAULT_PATH: '/vault', PYTHIA_VAULT_WATCH: '0' })
    expect(config.vault).toEqual({ root: '/vault', watch: false })
  })

  it('ignores the old PYTHIA_VAULT_EXCLUDED_FOLDERS: the Settings list replaced it (T24)', () => {
    const config = loadConfig({ ...base, PYTHIA_VAULT_PATH: '/vault', PYTHIA_VAULT_EXCLUDED_FOLDERS: 'Private' })
    expect(config.vault).toEqual({ root: '/vault', watch: true })
  })

  it('treats an empty repo config path as unset', () => {
    expect(loadConfig({ ...base, PYTHIA_REPOS_CONFIG: '' }).repos).toBeNull()
  })

  it('reads the repo config path, mirrors dir, fetch interval and GitHub token', () => {
    expect(loadConfig({ ...base, PYTHIA_REPOS_CONFIG: '/etc/repos.json' }).repos).toEqual({
      configFile: '/etc/repos.json',
      mirrorsDir: 'data/repos',
      fetchIntervalMs: 30 * 60_000,
      githubToken: null,
    })
    const token = 'github_' + 'pat_' + 'x'.repeat(30)
    expect(
      loadConfig({
        ...base,
        PYTHIA_REPOS_CONFIG: '/r.json',
        PYTHIA_REPOS_DIR: '/mirrors',
        PYTHIA_REPOS_FETCH_MINUTES: '60',
        GITHUB_TOKEN: token,
      }).repos,
    ).toEqual({ configFile: '/r.json', mirrorsDir: '/mirrors', fetchIntervalMs: 60 * 60_000, githubToken: token })
  })

  it('rejects a fetch interval under 5 minutes and a short token without echoing it', () => {
    expect(() => loadConfig({ ...base, PYTHIA_REPOS_FETCH_MINUTES: '1' })).toThrow(ConfigError)
    let message = ''
    try {
      loadConfig({ ...base, GITHUB_TOKEN: 'short-value' })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('GITHUB_TOKEN')
    expect(message).not.toContain('short-value')
  })

  it('ignores a HOST variable', () => {
    expect(loadConfig({ ...base, HOST: '0.0.0.0' }).host).toBe('127.0.0.1')
  })

  it('reads connection parts, PORT and OLLAMA_URL', () => {
    const config = loadConfig({
      ...base,
      PYTHIA_DB_HOST: 'postgres',
      PYTHIA_DB_PORT: '5432',
      PORT: '8080',
      OLLAMA_URL: 'http://ollama:11434',
    })
    expect(config.db.host).toBe('postgres')
    expect(config.db.port).toBe(5432)
    expect(config.port).toBe(8080)
    expect(config.ollamaUrl).toBe('http://ollama:11434')
  })

  it('rejects a missing database password', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({})).toThrow(new RegExp(PW_VAR))
  })

  it('names a bad variable without echoing any value', () => {
    let message = ''
    try {
      loadConfig({ ...base, PORT: '70000', OLLAMA_URL: 'not a url' })
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/PORT/)
    expect(message).toMatch(/OLLAMA_URL/)
    expect(message).not.toContain(pw)
    expect(message).not.toContain('not a url')
  })
})

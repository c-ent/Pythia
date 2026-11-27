import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { AskService } from '../ask/askService.js'
import type { FetchFn } from '../ask/llm.js'
import type { SearchService } from '../search/searchService.js'
import { SECRETS_KEY_BYTES } from '../security/secretBox.js'
import {
  classifyTestError,
  createGeminiSettings,
  createMemoryGeminiKeyStore,
  createMemoryGeminiUsageStore,
  usageDay,
  type GeminiKeyStore,
  type GeminiUsageStore,
} from '../settings/geminiSettings.js'
import { LlmError } from '../ask/llm.js'
import { testAuth } from './testAuth.js'

const { auth, cookie } = await testAuth()
const search = {} as SearchService
const ask = {} as AskService

// Built by concatenation so no key-like literal is committed.
const savedKey = 'AIza' + 's'.repeat(31) + 'Sv42'
const envKey = 'AIza' + 'e'.repeat(31) + 'Env7'
// 2026-11-26 20:00 in Taipei.
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)

const okBody = { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] }
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake Gemini endpoint: records the key each request carried. */
function fakeGemini(answer: (n: number) => Response | Error = () => json(200, okBody)) {
  const keys: string[] = []
  const fetch: FetchFn = async (_url, init) => {
    keys.push(new Headers(init.headers).get('x-goog-api-key') ?? '')
    const out = answer(keys.length)
    if (out instanceof Error) throw out
    return out
  }
  return { fetch, keys }
}

interface Setup {
  envKey?: string | null
  secretsKey?: Buffer | null
  keys?: GeminiKeyStore
  usage?: GeminiUsageStore
  fetch?: FetchFn
}

const servers: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function start(setup: Setup = {}) {
  const logs: string[] = []
  const keys = setup.keys ?? createMemoryGeminiKeyStore()
  const usage = setup.usage ?? createMemoryGeminiUsageStore()
  const gemini = createGeminiSettings({
    envKey: setup.envKey ?? null,
    secretsKey: setup.secretsKey === undefined ? randomBytes(SECRETS_KEY_BYTES) : setup.secretsKey,
    geminiModel: 'gemini-test',
    keys,
    usage,
    fetch: setup.fetch ?? fakeGemini().fetch,
    now: () => NOW,
    log: (message) => logs.push(message),
  })
  const server = createServer(createApp({ search, ask, auth, gemini }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) })
  const call = (method: string, path: string, body?: unknown, withCookie = true) =>
    fetch(`${base}/api/settings/gemini${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { gemini, keys, usage, logs, call }
}

describe('Gemini settings routes', () => {
  it('reports no key at first, and that one can be saved', async () => {
    const { call } = await start()
    const res = await call('GET', '')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      configured: false,
      source: null,
      last4: null,
      savedAt: null,
      envOverridesSaved: false,
      canSave: true,
      warning: null,
      model: 'gemini-test',
      usedToday: 0,
    })
  })

  it('saves a key encrypted and returns only its last 4 characters', async () => {
    const keys = createMemoryGeminiKeyStore()
    const { call } = await start({ keys })
    const saved = await call('PUT', '/key', { apiKey: `  ${savedKey}  ` })
    expect(saved.status).toBe(200)
    const text = await saved.text()
    expect(text).not.toContain(savedKey.slice(0, -4))
    expect(JSON.parse(text)).toMatchObject({ configured: true, source: 'settings', last4: 'Sv42', savedAt: new Date(NOW).toISOString() })

    const status = await (await call('GET', '')).text()
    expect(status).not.toContain(savedKey.slice(0, -4))
    expect(JSON.parse(status)).toMatchObject({ configured: true, source: 'settings', last4: 'Sv42' })

    // The stored row holds no plain key.
    const row = keys.stored()
    expect(row).not.toBeNull()
    for (const part of [row!.ciphertext, row!.iv, row!.authTag]) {
      expect(part.toString('latin1')).not.toContain('AIza')
    }
    expect(row!.last4).toBe('Sv42')
  })

  it('refuses to save without PYTHIA_SECRETS_KEY, with a clear message', async () => {
    const keys = createMemoryGeminiKeyStore()
    const { call } = await start({ secretsKey: null, keys })
    expect(await (await call('GET', '')).json()).toMatchObject({ canSave: false })
    const res = await call('PUT', '/key', { apiKey: savedKey })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('secrets_key_missing')
    expect(body.error.message).toMatch(/PYTHIA_SECRETS_KEY/)
    expect(keys.stored()).toBeNull()
  })

  it('lets the .env key win over a saved one', async () => {
    const secretsKey = randomBytes(SECRETS_KEY_BYTES)
    const keys = createMemoryGeminiKeyStore()
    const gemini = fakeGemini()
    const { call } = await start({ envKey, secretsKey, keys, fetch: gemini.fetch })
    await call('PUT', '/key', { apiKey: savedKey })
    const status = await (await call('GET', '')).json()
    expect(status).toMatchObject({ configured: true, source: 'env', last4: 'Env7', envOverridesSaved: true })
    await call('POST', '/test')
    expect(gemini.keys).toEqual([envKey])
  })

  it('treats a key it cannot decrypt (wrong PYTHIA_SECRETS_KEY) as no key, with a warning', async () => {
    const keys = createMemoryGeminiKeyStore()
    const first = await start({ keys, secretsKey: randomBytes(SECRETS_KEY_BYTES) })
    await first.call('PUT', '/key', { apiKey: savedKey })

    const gemini = fakeGemini()
    const restored = await start({ keys, secretsKey: randomBytes(SECRETS_KEY_BYTES), fetch: gemini.fetch })
    expect(await (await restored.call('GET', '')).json()).toMatchObject({
      configured: false,
      source: null,
      last4: null,
      warning: 'undecryptable',
    })
    expect(await restored.gemini.model()).toBeNull()
    expect(await (await restored.call('POST', '/test')).json()).toEqual({ ok: false, error: 'no_key' })
    expect(gemini.keys).toEqual([])

    const unset = await start({ keys, secretsKey: null })
    expect(await (await unset.call('GET', '')).json()).toMatchObject({ configured: false, warning: 'secrets_key_missing' })
  })

  it('removes the saved key', async () => {
    const keys = createMemoryGeminiKeyStore()
    const { call } = await start({ keys })
    await call('PUT', '/key', { apiKey: savedKey })
    const res = await call('DELETE', '/key')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ configured: false, source: null, savedAt: null })
    expect(keys.stored()).toBeNull()
  })

  it.each([
    [{ apiKey: 'short' }, /at least 20/],
    [{ apiKey: 'AIza' + 'x'.repeat(10) + ' ' + 'y'.repeat(10) }, /spaces or control/],
    [{ apiKey: 'x'.repeat(300) }, /at most 256/],
    [{}, /apiKey/],
  ])('rejects invalid input %# with 400', async (body, message) => {
    const keys = createMemoryGeminiKeyStore()
    const { call } = await start({ keys })
    const res = await call('PUT', '/key', body)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(message)
    expect(keys.stored()).toBeNull()
  })

  it('needs a session', async () => {
    const keys = createMemoryGeminiKeyStore()
    const { call } = await start({ keys })
    expect((await call('GET', '', undefined, false)).status).toBe(401)
    expect((await call('PUT', '/key', { apiKey: savedKey }, false)).status).toBe(401)
    expect((await call('DELETE', '/key', undefined, false)).status).toBe(401)
    expect((await call('POST', '/test', undefined, false)).status).toBe(401)
    expect(keys.stored()).toBeNull()
  })

  it('tests the key with one call and counts it', async () => {
    const gemini = fakeGemini()
    const { call } = await start({ fetch: gemini.fetch })
    await call('PUT', '/key', { apiKey: savedKey })
    const res = await call('POST', '/test')
    expect(await res.json()).toEqual({ ok: true })
    expect(gemini.keys).toEqual([savedKey])
    expect(await (await call('GET', '')).json()).toMatchObject({ usedToday: 1 })
  })

  it.each([
    [() => json(400, { error: { status: 'INVALID_ARGUMENT' } }), 'invalid_key'],
    [() => json(403, {}), 'invalid_key'],
    [() => json(429, {}), 'rate_limited'],
    [() => json(503, {}), 'unreachable'],
    [() => new TypeError('fetch failed'), 'unreachable'],
  ])('reports the error class of a failed test (%#)', async (answer, error) => {
    const gemini = fakeGemini(answer)
    const { call, logs } = await start({ fetch: gemini.fetch })
    await call('PUT', '/key', { apiKey: savedKey })
    expect(await (await call('POST', '/test')).json()).toEqual({ ok: false, error })
    // One attempt only: Test never retries.
    expect(gemini.keys).toHaveLength(1)
    expect(logs.join('\n')).not.toContain(savedKey)
  })

  it('answers 404 without a Gemini settings service', async () => {
    const server = createServer(createApp({ search, ask, auth }))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/settings/gemini`, { headers: { cookie } })).status).toBe(404)
  })
})

describe('Gemini settings service', () => {
  it('counts every request the answer model sends, retries included, per Taipei day', async () => {
    let now = NOW
    const usage = createMemoryGeminiUsageStore()
    const gemini = fakeGemini((n) => (n === 1 ? json(503, {}) : json(200, okBody)))
    const service = createGeminiSettings({
      envKey,
      secretsKey: null,
      geminiModel: 'gemini-test',
      keys: createMemoryGeminiKeyStore(),
      usage,
      fetch: gemini.fetch,
      sleep: async () => {},
      now: () => now,
    })
    const model = await service.model()
    expect(model).not.toBeNull()
    // The first attempt fails with 503 and is retried: two requests.
    expect(await model!.generate({ system: 's', user: 'u' })).toBe('OK')
    expect(await usage.get('2026-11-26')).toBe(2)
    expect((await service.status()).usedToday).toBe(2)

    // 16:00 UTC is midnight in Taipei: a new day starts at 0.
    now = Date.UTC(2026, 10, 26, 16, 0, 0)
    expect((await service.status()).usedToday).toBe(0)
  })

  it('uses the Asia/Taipei date', () => {
    expect(usageDay(Date.UTC(2026, 10, 26, 15, 59, 59))).toBe('2026-11-26')
    expect(usageDay(Date.UTC(2026, 10, 26, 16, 0, 0))).toBe('2026-11-27')
  })

  it('keeps answering when the counter fails, logging no key', async () => {
    const logs: string[] = []
    const service = createGeminiSettings({
      envKey,
      secretsKey: null,
      geminiModel: 'gemini-test',
      keys: createMemoryGeminiKeyStore(),
      usage: {
        increment: async () => {
          throw new Error(`db down ${envKey}`)
        },
        get: async () => 0,
      },
      fetch: fakeGemini().fetch,
      log: (message) => logs.push(message),
    })
    expect(await (await service.model())!.generate({ system: 's', user: 'u' })).toBe('OK')
    expect(logs).toEqual(['gemini usage count failed: Error'])
  })

  it('classifies test errors', () => {
    expect(classifyTestError(new LlmError('x', { status: 401 }))).toBe('invalid_key')
    expect(classifyTestError(new LlmError('x', { status: 404 }))).toBe('failed')
    expect(classifyTestError(new LlmError('x'))).toBe('unreachable')
    expect(classifyTestError(new Error('x'))).toBe('failed')
  })
})

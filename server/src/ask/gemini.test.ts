import { describe, expect, it } from 'vitest'
import { createGeminiModel, DEFAULT_GEMINI_MODEL } from './gemini.js'
import { LlmError, parseRetryAfter, type FetchFn } from './llm.js'

// Built by concatenation so no literal key is ever committed.
const KEY = 'AIza' + 'test'.repeat(9)
const prompt = { system: 'Be brief.', user: 'What is the goal?' }

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const answer = (text: string) => ok({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] })

function recorder(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next === undefined) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return next
  }
  return { fetch, calls }
}

describe('gemini model', () => {
  it('posts generateContent with the key in a header, never the URL', async () => {
    const { fetch, calls } = recorder([answer('The goal [1].')])
    const model = createGeminiModel({ apiKey: KEY, fetch })

    expect(await model.generate(prompt)).toBe('The goal [1].')
    expect(model).toMatchObject({ engine: 'gemini', model: DEFAULT_GEMINI_MODEL })

    const call = calls[0]
    expect(call?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`)
    expect(call?.url).not.toContain(KEY)
    expect((call?.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'What is the goal?' }] }],
    })
  })

  it('joins text parts and drops thought parts', async () => {
    const { fetch } = recorder([
      ok({ candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'A ' }, { text: 'B' }] } }] }),
    ])
    expect(await createGeminiModel({ apiKey: KEY, fetch }).generate(prompt)).toBe('A B')
  })

  it('backs off exponentially on 429 and then succeeds', async () => {
    const { fetch, calls } = recorder([new Response('', { status: 429 }), new Response('', { status: 429 }), answer('ok')])
    const s = { sleeps: [] as number[] }
    const model = createGeminiModel({ apiKey: KEY, fetch, retryDelayMs: 100, sleep: async (ms) => void s.sleeps.push(ms) })
    expect(await model.generate(prompt)).toBe('ok')
    expect(calls).toHaveLength(3)
    expect(s.sleeps).toEqual([100, 200])
  })

  it('waits for Retry-After when it is longer than the backoff', async () => {
    const { fetch } = recorder([new Response('', { status: 429, headers: { 'retry-after': '3' } }), answer('ok')])
    const s = { sleeps: [] as number[] }
    const model = createGeminiModel({ apiKey: KEY, fetch, retryDelayMs: 100, sleep: async (ms) => void s.sleeps.push(ms) })
    await model.generate(prompt)
    expect(s.sleeps).toEqual([3000])
  })

  it('gives up on a long Retry-After so Ask can fall back', async () => {
    const { fetch, calls } = recorder([new Response('', { status: 429, headers: { 'retry-after': '3600' } })])
    const model = createGeminiModel({ apiKey: KEY, fetch, sleep: async () => {} })
    await expect(model.generate(prompt)).rejects.toMatchObject({ name: 'LlmError', status: 429 })
    expect(calls).toHaveLength(1)
  })

  it('stops after the retry budget', async () => {
    const { fetch, calls } = recorder([503, 503, 503].map((status) => new Response('', { status })))
    const model = createGeminiModel({ apiKey: KEY, fetch, retries: 2, retryDelayMs: 1, sleep: async () => {} })
    await expect(model.generate(prompt)).rejects.toBeInstanceOf(LlmError)
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 400 or 403, and never echoes the error body or key', async () => {
    const { fetch, calls } = recorder([
      new Response(JSON.stringify({ error: { message: `API key ${KEY} not valid; prompt: What is the goal?` } }), { status: 400 }),
    ])
    const error = await createGeminiModel({ apiKey: KEY, fetch, sleep: async () => {} })
      .generate(prompt)
      .catch((e: unknown) => e)
    expect(calls).toHaveLength(1)
    expect(error).toMatchObject({ status: 400, retryable: false })
    expect(String(error)).not.toContain(KEY)
    expect(String(error)).not.toContain('goal')
  })

  it('does not retry a network failure or timeout', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    const { fetch, calls } = recorder([timeout])
    await expect(createGeminiModel({ apiKey: KEY, fetch, sleep: async () => {} }).generate(prompt)).rejects.toThrow(/timed out/)
    expect(calls).toHaveLength(1)
  })

  it('throws on a blocked prompt, no candidates, or empty text', async () => {
    for (const body of [
      { promptFeedback: { blockReason: 'SAFETY' } },
      { candidates: [] },
      { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] },
    ]) {
      const { fetch } = recorder([ok(body)])
      await expect(createGeminiModel({ apiKey: KEY, fetch }).generate(prompt)).rejects.toBeInstanceOf(LlmError)
    }
  })

  it('refuses an empty key', () => {
    expect(() => createGeminiModel({ apiKey: ' ' })).toThrow(RangeError)
  })

  it('uses a configured model and base URL', async () => {
    const { fetch, calls } = recorder([answer('ok')])
    await createGeminiModel({ apiKey: KEY, fetch, model: 'gemini-4-hydrogen', baseUrl: 'https://proxy.test/v1beta/' }).generate(prompt)
    expect(calls[0]?.url).toBe('https://proxy.test/v1beta/models/gemini-4-hydrogen:generateContent')
  })
})

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('1.5')).toBe(1500)
    const now = Date.parse('2026-11-25T00:00:00Z')
    expect(parseRetryAfter('Wed, 25 Nov 2026 00:00:10 GMT', now)).toBe(10_000)
    expect(parseRetryAfter('Tue, 24 Nov 2026 00:00:10 GMT', now)).toBe(0)
  })

  it('ignores missing or unreadable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('soon')).toBeUndefined()
  })
})

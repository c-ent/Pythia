import { describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_PREFIX,
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  QUERY_PREFIX,
  OllamaError,
  createOllamaEmbedder,
  type FetchFn,
} from './ollama.js'

interface EmbedBody {
  model: string
  input: string[]
}

const vector = (seed: number, dims = EMBED_DIMENSIONS): number[] => Array.from({ length: dims }, (_, i) => seed + i / dims)

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fake Ollama that returns one vector per input, seeded by the input's position across all calls. */
function fakeOllama() {
  const bodies: EmbedBody[] = []
  const urls: string[] = []
  let served = 0
  const fetch = vi.fn<FetchFn>(async (url, init) => {
    urls.push(url)
    const body = JSON.parse(String(init.body)) as EmbedBody
    bodies.push(body)
    const embeddings = body.input.map(() => vector(served++))
    return json(200, { model: body.model, embeddings })
  })
  return { fetch, bodies, urls }
}

const noSleep = vi.fn(async () => {})

describe('createOllamaEmbedder', () => {
  it('posts to /api/embed with the model, keeping a base path', async () => {
    const fake = fakeOllama()
    const embedder = createOllamaEmbedder({ baseUrl: 'http://ollama:11434/proxy/', fetch: fake.fetch })
    await embedder.embedQuery('hi')
    expect(fake.urls).toEqual(['http://ollama:11434/proxy/api/embed'])
    expect(fake.bodies[0]?.model).toBe(EMBED_MODEL)
    expect(embedder).toMatchObject({ model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS })
  })

  it('prefixes documents with search_document: and queries with search_query:', async () => {
    const fake = fakeOllama()
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch: fake.fetch })
    await embedder.embedDocuments(['Note > A\n\nbody', 'second'])
    await embedder.embedQuery('what is pythia')
    expect(fake.bodies[0]?.input).toEqual([`${DOCUMENT_PREFIX}Note > A\n\nbody`, `${DOCUMENT_PREFIX}second`])
    expect(fake.bodies[1]?.input).toEqual([`${QUERY_PREFIX}what is pythia`])
    expect(DOCUMENT_PREFIX).toBe('search_document: ')
    expect(QUERY_PREFIX).toBe('search_query: ')
  })

  it('splits documents into batches of 32 and keeps input order', async () => {
    const fake = fakeOllama()
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch: fake.fetch })
    const texts = Array.from({ length: 70 }, (_, i) => `chunk ${i}`)
    const vectors = await embedder.embedDocuments(texts)
    expect(fake.bodies.map((body) => body.input.length)).toEqual([32, 32, 6])
    expect(fake.bodies[2]?.input[5]).toBe(`${DOCUMENT_PREFIX}chunk 69`)
    expect(vectors).toHaveLength(70)
    expect(vectors.map((v) => v[0])).toEqual(texts.map((_, i) => i))
  })

  it('honours a custom batch size', async () => {
    const fake = fakeOllama()
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch: fake.fetch, batchSize: 16 })
    await embedder.embedDocuments(Array.from({ length: 33 }, () => 't'))
    expect(fake.bodies.map((body) => body.input.length)).toEqual([16, 16, 1])
  })

  it('makes no request for an empty list', async () => {
    const fake = fakeOllama()
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch: fake.fetch })
    expect(await embedder.embedDocuments([])).toEqual([])
    expect(fake.fetch).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5])('rejects batch size %s', (batchSize) => {
    expect(() => createOllamaEmbedder({ baseUrl: 'http://x', batchSize })).toThrow(RangeError)
  })

  it('rejects vectors of the wrong dimension', async () => {
    const fetch = vi.fn<FetchFn>(async () => json(200, { embeddings: [vector(0, 384)] }))
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch })
    await expect(embedder.embedQuery('q')).rejects.toThrow(/not 768 finite numbers/)
  })

  it('rejects non-finite values', async () => {
    const bad = vector(0)
    bad[3] = Number.NaN
    // JSON turns NaN into null, which is also not a finite number.
    const fetch = vi.fn<FetchFn>(async () => json(200, { embeddings: [bad] }))
    await expect(createOllamaEmbedder({ baseUrl: 'http://x', fetch }).embedQuery('q')).rejects.toThrow(OllamaError)
  })

  it('rejects a response with the wrong number of embeddings', async () => {
    const fetch = vi.fn<FetchFn>(async () => json(200, { embeddings: [vector(0)] }))
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch })
    await expect(embedder.embedDocuments(['a', 'b'])).rejects.toThrow('returned 1 embeddings for 2 inputs')
  })

  it('rejects a body without embeddings', async () => {
    const fetch = vi.fn<FetchFn>(async () => json(200, { nope: true }))
    await expect(createOllamaEmbedder({ baseUrl: 'http://x', fetch }).embedQuery('q')).rejects.toThrow(
      'returned no embeddings for 1 inputs',
    )
  })

  it('reports Ollama errors without echoing the input text', async () => {
    const fetch = vi.fn<FetchFn>(async () => json(404, { error: 'model "nomic-embed-text" not found, try pulling it first' }))
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch, sleep: noSleep })
    const error = await embedder.embedDocuments(['my private diary entry']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OllamaError)
    expect(error).toMatchObject({ status: 404, retryable: false })
    expect(String((error as Error).message)).toContain('HTTP 404: model "nomic-embed-text" not found')
    expect(String((error as Error).message)).not.toContain('diary')
    // 4xx is not retried.
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries 5xx and 429 with doubling delays, then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    const fetch = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(json(503, { error: 'loading model' }))
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(200, { embeddings: [vector(7)] }))
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch, sleep, retryDelayMs: 100 })
    expect((await embedder.embedQuery('q'))[0]).toBe(7)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[100], [200]])
  })

  it('retries network errors and gives up after the retry budget', async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      throw new TypeError('fetch failed')
    })
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch, sleep: noSleep, retries: 2 })
    await expect(embedder.embedQuery('q')).rejects.toThrow('Ollama embed request failed: fetch failed')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('reports a timeout as such', async () => {
    const fetch = vi.fn<FetchFn>(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch, retries: 0, timeoutMs: 1234 })
    await expect(embedder.embedQuery('q')).rejects.toThrow('timed out after 1234 ms')
  })
})

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  a.forEach((x, i) => {
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  })
  return dot / Math.sqrt(na * nb)
}

// Opt-in with PYTHIA_OLLAMA_TESTS=1 in .env; needs `docker compose up -d ollama`
// with `nomic-embed-text` pulled. Only made-up text is sent.
describe.skipIf(process.env.PYTHIA_OLLAMA_TESTS !== '1')('live Ollama smoke test', () => {
  const embedder = createOllamaEmbedder({ baseUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434' })

  it('returns 768-dim vectors that rank the related document first', { timeout: 120_000 }, async () => {
    const [cat, tax] = await embedder.embedDocuments([
      'Garden notes > Pets\n\nThe cat sleeps on the sunny windowsill every afternoon.',
      'Finance > Taxes\n\nQuarterly tax filing deadlines for a small business.',
    ])
    const query = await embedder.embedQuery('where does my cat nap?')
    for (const v of [cat, tax, query]) expect(v).toHaveLength(EMBED_DIMENSIONS)
    expect(cosine(query, cat ?? [])).toBeGreaterThan(cosine(query, tax ?? []))
  })
})

import { describe, expect, it } from 'vitest'
import { createEmbedGate } from './embedGate.js'
import { createOllamaEmbedder, type FetchFn } from './ollama.js'

// T51: a query embed waiting at the gate goes before the next index batch.

interface Deferred {
  resolve: () => void
  promise: Promise<void>
}

const deferred = (): Deferred => {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { resolve, promise }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('embed gate', () => {
  it('runs a waiting query before the next queued index tasks, and index tasks in order', async () => {
    const gate = createEmbedGate()
    const order: string[] = []
    const first = deferred()
    const running = gate.run('index', async () => {
      order.push('index 1')
      await first.promise
    })
    const rest = [2, 3, 4].map((n) => gate.run('index', async () => void order.push(`index ${n}`)))
    await tick()
    const query = gate.run('query', async () => void order.push('query'))
    await tick()
    expect(order).toEqual(['index 1'])

    first.resolve()
    await Promise.all([running, query, ...rest])
    expect(order).toEqual(['index 1', 'query', 'index 2', 'index 3', 'index 4'])
  })

  it('runs one task at a time', async () => {
    const gate = createEmbedGate()
    let active = 0
    let peak = 0
    const task = async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
    }
    await Promise.all([gate.run('index', task), gate.run('query', task), gate.run('index', task), gate.run('query', task)])
    expect(peak).toBe(1)
  })

  it('keeps going after a failed task', async () => {
    const gate = createEmbedGate()
    await expect(gate.run('index', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.run('query', async () => 'ok')).resolves.toBe('ok')
  })

  it('drops a waiting task whose signal aborts, without running it', async () => {
    const gate = createEmbedGate()
    const hold = deferred()
    const running = gate.run('index', () => hold.promise)
    const controller = new AbortController()
    let ran = false
    const waiting = gate.run('query', async () => void (ran = true), controller.signal)
    controller.abort(new Error('gave up'))
    await expect(waiting).rejects.toThrow('gave up')
    hold.resolve()
    await running
    await expect(gate.run('index', async () => 'next')).resolves.toBe('next')
    expect(ran).toBe(false)
  })
})

describe('Ollama embedders sharing a gate', () => {
  const vector = () => Array.from({ length: 768 }, () => 0.5)

  it('sends a search query before the rest of an index batch, one chunk per request', async () => {
    const sent: string[][] = []
    const gates: Deferred[] = []
    const fetch: FetchFn = async (_url, init) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input
      sent.push(input)
      const wait = deferred()
      gates.push(wait)
      await wait.promise
      return new Response(JSON.stringify({ embeddings: input.map(vector) }), { status: 200 })
    }
    const gate = createEmbedGate()
    const index = createOllamaEmbedder({ baseUrl: 'http://x', fetch, gate, priority: 'index', turnSize: 1 })
    const query = createOllamaEmbedder({ baseUrl: 'http://x', fetch, gate, priority: 'query', retries: 0 })

    const indexing = index.embedDocuments(['a', 'b', 'c'])
    await tick()
    const searching = query.embedQuery('q')
    await tick()
    expect(sent).toEqual([['search_document: a']])

    gates[0]?.resolve()
    await tick()
    await tick()
    expect(sent[1]).toEqual(['search_query: q'])
    gates[1]?.resolve()
    expect(await searching).toHaveLength(768)

    for (let i = 2; i < 4; i++) {
      await tick()
      await tick()
      gates[i]?.resolve()
    }
    expect(await indexing).toHaveLength(3)
    expect(sent.slice(2)).toEqual([['search_document: b'], ['search_document: c']])
  })

  it('fails a query that waits at the gate past its timeout, without sending it', async () => {
    const sent: string[][] = []
    const hold = deferred()
    const fetch: FetchFn = async (_url, init) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input
      sent.push(input)
      await hold.promise
      return new Response(JSON.stringify({ embeddings: input.map(vector) }), { status: 200 })
    }
    const gate = createEmbedGate()
    const index = createOllamaEmbedder({ baseUrl: 'http://x', fetch, gate, priority: 'index', timeoutMs: 60_000 })
    const query = createOllamaEmbedder({ baseUrl: 'http://x', fetch, gate, priority: 'query', retries: 0, timeoutMs: 30 })

    const indexing = index.embedDocuments(['a'])
    await expect(query.embedQuery('q')).rejects.toMatchObject({ name: 'OllamaError', retryable: true })
    hold.resolve()
    await indexing
    expect(sent).toEqual([['search_document: a']])
  })

  it('splits a batch into turns of turnSize and keeps vector order', async () => {
    const sizes: number[] = []
    const fetch: FetchFn = async (_url, init) => {
      const input = (JSON.parse(String(init.body)) as { input: string[] }).input
      sizes.push(input.length)
      return new Response(
        JSON.stringify({ embeddings: input.map((text) => Array.from({ length: 768 }, () => text.length)) }),
        { status: 200 },
      )
    }
    const embedder = createOllamaEmbedder({ baseUrl: 'http://x', fetch, batchSize: 4, turnSize: 3 })
    const vectors = await embedder.embedDocuments(['a', 'bb', 'ccc', 'dddd', 'eeeee'])
    expect(sizes).toEqual([3, 1, 1])
    expect(vectors.map((v) => v[0])).toEqual([18, 19, 20, 21, 22])
  })
})

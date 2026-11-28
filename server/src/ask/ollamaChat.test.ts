import { describe, expect, it } from 'vitest'
import { LlmError, type FetchFn } from './llm.js'
import { createOllamaChatModel, DEFAULT_OLLAMA_CHAT_MODEL, stripThinking } from './ollamaChat.js'

const prompt = { system: 'Be brief.', user: 'What is the goal?' }

function recorder(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }
  return { fetch, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('ollama chat model', () => {
  it('posts a non-streaming chat with system and user messages', async () => {
    const { fetch, calls } = recorder(json({ message: { role: 'assistant', content: 'The goal [1].' } }))
    const model = createOllamaChatModel({ baseUrl: 'http://127.0.0.1:11434/', fetch })

    expect(await model.generate(prompt)).toBe('The goal [1].')
    expect(model).toMatchObject({ engine: 'ollama', model: DEFAULT_OLLAMA_CHAT_MODEL })
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: DEFAULT_OLLAMA_CHAT_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'What is the goal?' },
      ],
    })
  })

  it('strips inline thinking from the answer', async () => {
    const { fetch } = recorder(json({ message: { content: '<think>hmm</think>\n\nAnswer [2].' } }))
    expect(await createOllamaChatModel({ baseUrl: 'http://x', fetch }).generate(prompt)).toBe('Answer [2].')
  })

  it('reports a missing model with Ollama’s own error', async () => {
    const { fetch } = recorder(json({ error: "model 'qwen3:4b' not found" }, 404))
    await expect(createOllamaChatModel({ baseUrl: 'http://x', fetch }).generate(prompt)).rejects.toThrow(
      /HTTP 404: model 'qwen3:4b' not found/,
    )
  })

  it('throws LlmError on network failure, timeout and empty answers', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    for (const response of [new Error('ECONNREFUSED'), timeout, json({ message: { content: '  ' } }), json({})]) {
      const { fetch } = recorder(response)
      await expect(createOllamaChatModel({ baseUrl: 'http://x', fetch }).generate(prompt)).rejects.toBeInstanceOf(LlmError)
    }
  })

  it('streams NDJSON tokens, strips <think> blocks across chunks, and sends history', async () => {
    const chunks = [
      `${JSON.stringify({ message: { content: '<thi' } })}\n`,
      `${JSON.stringify({ message: { content: 'nk>reasoning</think>  ' } })}\n`,
      `${JSON.stringify({ message: { content: 'Hello ' } })}\n`,
      `${JSON.stringify({ message: { content: 'local.' }, done: true })}\n`,
    ]
    let sentBody = ''
    const fetchFn: FetchFn = async (_url, init) => {
      sentBody = String(init.body)
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      )
    }
    const model = createOllamaChatModel({ baseUrl: 'http://x', fetch: fetchFn })
    const tokens: string[] = []
    const answer = await model.generateStream!(
      { system: 'sys', user: 'follow-up', history: [{ question: 'q1', answer: 'a1' }] },
      (delta) => tokens.push(delta),
    )
    expect(tokens).toEqual(['Hello ', 'local.'])
    expect(answer).toBe('Hello local.')
    expect(JSON.parse(sentBody).messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'follow-up' },
    ])
  })
})

describe('stripThinking', () => {
  it('removes closed think blocks and a leading unclosed one', () => {
    expect(stripThinking('<think>a</think>B')).toBe('B')
    expect(stripThinking('reasoning</think> Answer')).toBe('Answer')
    expect(stripThinking('Plain answer')).toBe('Plain answer')
  })
})

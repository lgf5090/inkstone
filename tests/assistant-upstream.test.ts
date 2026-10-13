// @vitest-environment node
/**
 * The provider wire, tested against recorded frames rather than a live service.
 *
 * The three protocols all stream JSON in pieces, and the piece that matters — a tool call's arguments
 * arriving three characters at a time — is exactly what a hand-written parser gets wrong in a way no
 * other test can see. The failure looks like a tool that was called with `{}`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantProtocol } from '../src/shared/assistant'
import { UpstreamError, readSse, streamUpstream, type UpstreamEvent, type UpstreamRequest } from '../src/worker/assistant/upstream'

const BASE = { baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'm', signal: new AbortController().signal }

function sseBody(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

function response(frames: readonly string[], init: ResponseInit = {}): Response {
  return new Response(sseBody(frames), { headers: { 'content-type': 'text/event-stream' }, ...init })
}

function data(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

function request(overrides: Partial<UpstreamRequest> = {}): UpstreamRequest {
  return {
    ...BASE,
    system: 'You are helpful.',
    turns: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'create_task', description: 'd', parameters: { type: 'object', properties: {} } }],
    maxOutputTokens: 512,
    temperature: 0.2,
    reasoning: 'auto',
    ...overrides,
  } as UpstreamRequest
}

async function collect(protocol: AssistantProtocol, body: ReadableStream<Uint8Array>, req = request()): Promise<UpstreamEvent[]> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })))
  const events: UpstreamEvent[] = []
  for await (const event of streamUpstream(protocol, { ...req, signal: req.signal })) events.push(event)
  return events
}

const openAiFrame = (delta: Record<string, unknown>, finish: string | null = null) => data({ choices: [{ index: 0, delta, finish_reason: finish }] })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('openai-compatible wire', () => {
  it('reassembles a tool call whose arguments arrive in fragments', async () => {
    const events = await collect('openai', sseBody([
      openAiFrame({ content: 'Sure' }),
      openAiFrame({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_', arguments: '{"tit' } }] }),
      openAiFrame({ tool_calls: [{ index: 0, function: { name: 'task', arguments: 'le":"Ren' } }] }),
      openAiFrame({ tool_calls: [{ index: 0, function: { arguments: 't the deck"}' } }] }),
      openAiFrame({}, 'tool_calls'),
    ]))
    const call = events.find((event) => event.type === 'tool-call')
    expect(call).toMatchObject({ type: 'tool-call', id: 'call_1', name: 'create_task' })
    expect((call as { args: unknown }).args).toEqual({ title: 'Rent the deck' })
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { delta: string }).delta).join('')).toBe('Sure')
  })

  it('keeps two calls in the same stream apart', async () => {
    const events = await collect('openai', sseBody([
      openAiFrame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] }),
      openAiFrame({ tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] }),
      openAiFrame({}, 'tool_calls'),
    ]))
    const names = events.filter((event) => event.type === 'tool-call').map((event) => (event as { name: string }).name)
    expect(names).toEqual(['first', 'second'])
  })

  it('reports a chain of thought separately from the answer', async () => {
    const events = await collect('openai', sseBody([
      openAiFrame({ reasoning_content: 'thinking' }),
      openAiFrame({ content: 'answer' }),
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      data({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    ]))
    expect(events).toContainEqual({ type: 'reasoning', delta: 'thinking' })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 11, outputTokens: 7 })
  })

  it('reads a frame split across chunks, quotes and all', async () => {
    const payload = openAiFrame({ content: 'line one\nline two' })
    const half = Math.ceil(payload.length / 2)
    const events = await collect('openai', sseBody([payload.slice(0, half), payload.slice(half)]))
    expect(events).toContainEqual({ type: 'text', delta: 'line one\nline two' })
  })

  it('stops on [DONE] without inventing an event', async () => {
    const events = await collect('openai', sseBody([openAiFrame({ content: 'x' }), data('[DONE]')]))
    expect(events.map((event) => event.type)).toEqual(['text'])
  })
})

describe('anthropic wire', () => {
  it('accumulates partial JSON and reads usage off the final delta', async () => {
    const events = await collect('anthropic', sseBody([
      data({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      data({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
      data({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'create_task' } }),
      data({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"title"' } }),
      data({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ': "Book a vet"}' } }),
      data({ type: 'content_block_stop', index: 2 }),
      data({ type: 'message_delta', usage: { output_tokens: 9 } }),
      data({ type: 'message_stop' }),
    ]))
    expect(events.filter((event) => event.type === 'text').map((event) => (event as { delta: string }).delta).join('')).toBe('Hello')
    const call = events.find((event) => event.type === 'tool-call') as { args: unknown, id: string }
    expect(call.id).toBe('tu_1')
    expect(call.args).toEqual({ title: 'Book a vet' })
    // The prompt size only ever arrives in message_start; the answer size comes in message_delta.
    expect(events.at(-1)).toEqual({ type: 'usage', inputTokens: 5, outputTokens: 9 })
  })
})

describe('gemini wire', () => {
  it('maps function calls, text and thought parts', async () => {
    const events = await collect('gemini', sseBody([
      data({ candidates: [{ content: { parts: [{ text: 'Hi', thought: true }] } }] }),
      data({ candidates: [{ content: { parts: [{ text: 'There' }] } }] }),
      data({
        candidates: [{
          content: { parts: [{ functionCall: { id: 'fc_1', name: 'create_task', args: { title: 'x' } } }] },
        }],
      }),
      data({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }),
    ]))
    expect(events).toContainEqual({ type: 'reasoning', delta: 'Hi' })
    expect(events).toContainEqual({ type: 'text', delta: 'There' })
    const call = events.find((event) => event.type === 'tool-call') as { name: string, args: unknown }
    expect(call.name).toBe('create_task')
    expect((call.args as Record<string, unknown>).title).toBe('x')
    expect(events).toContainEqual({ type: 'usage', inputTokens: 3, outputTokens: 4 })
  })
})

describe('failure paths', () => {
  it('turns a redirect into a refusal rather than a follow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })))
    const caught = await streamUpstream('openai', request()).next().then(() => null).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(UpstreamError)
    expect((caught as UpstreamError).kind).toBe('unreachable')
    expect((caught as UpstreamError).message).toContain('redirect')
  })

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate'],
    [503, 'unreachable'],
    [400, 'bad-request'],
  ] as const)('maps HTTP %i to a %s failure', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'no' } }), { status })))
    const error = await streamUpstream('openai', request()).next().then(() => null).catch((caught: unknown) => caught)
    expect((error as UpstreamError).kind).toBe(kind)
    expect((error as UpstreamError).status).toBe(status)
  })

  it('separates a quota answer from a rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('insufficient quota', { status: 429 })))
    const error = await streamUpstream('openai', request()).next().catch((caught: unknown) => caught)
    expect((error as UpstreamError).kind).toBe('quota')
  })

  it('refuses a private provider address before any request is made', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const baseUrl of ['http://127.0.0.1:11434', 'http://169.254.169.254', 'http://localhost:8000']) {
      const caught = await streamUpstream('openai', request({ baseUrl })).next().then(() => null).catch((error: unknown) => error)
      expect((caught as UpstreamError).kind, baseUrl).toBe('bad-request')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a stalled stream as a timeout, not as a finished answer', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
        // then nothing: the provider has gone silent mid-sentence
      },
      cancel() {
        cancelled = true
      },
    })
    const frames: string[] = []
    let failure: unknown = null
    try {
      for await (const frame of readSse(body, new AbortController().signal, { first: 10, idle: 10 })) frames.push(frame)
    } catch (error) {
      failure = error
    }
    // The cancel travels down the TextDecoderStream pipe on its own promise, so let it land.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames).toEqual(['{"a":1}'])
    expect(cancelled).toBe(true)
    expect(failure).toBeInstanceOf(UpstreamError)
    expect((failure as UpstreamError).kind).toBe('timeout')
  })

  it('ends a stream that simply stopped cleanly without inventing a timeout', async () => {
    const frames: string[] = []
    for await (const frame of readSse(sseBody(['data: {"a":1}\n\n']), new AbortController().signal, { first: 5_000, idle: 5_000 })) {
      frames.push(frame)
    }
    expect(frames).toEqual(['{"a":1}'])
  })

  it('keeps cancelling the download after the headers arrived', async () => {
    const controller = new AbortController()
    let inner: AbortSignal | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      inner = init.signal
      return response([openAiFrame({ content: 'x' })])
    }))
    const events: UpstreamEvent[] = []
    for await (const event of streamUpstream('openai', request({ signal: controller.signal }))) events.push(event)
    expect(events.length).toBe(1)
    expect(inner).not.toBeNull()
    // Detaching the listener once the response began would leave a closed tab's stream running.
    controller.abort()
    expect((inner as AbortSignal).aborted).toBe(true)
  })
})

describe('readSse', () => {
  it('yields each data payload and ignores comment lines', async () => {
    const body = sseBody([': ping\n\n', 'data: {"a":1}\n\ndata: {"b":2}\n\n'])
    const out: string[] = []
    for await (const frame of readSse(body, new AbortController().signal)) out.push(frame)
    expect(out).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('treats a CRLF frame boundary as a boundary', async () => {
    const out: string[] = []
    for await (const frame of readSse(sseBody(['data: one\r\n\r\ndata: two\r\n\r\n']), new AbortController().signal)) out.push(frame)
    expect(out).toEqual(['one', 'two'])
  })
})

/** The JSON body a protocol would put on the wire for one request. */
async function sentBody(protocol: AssistantProtocol, overrides: Partial<UpstreamRequest> = {}): Promise<Record<string, unknown>> {
  let captured = ''
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    captured = String(init?.body ?? '')
    return response([protocol === 'anthropic'
      ? data({ type: 'message_stop' })
      : protocol === 'gemini'
        ? data({ candidates: [{ finishReason: 'STOP' }] })
        : data({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })])
  }))
  for await (const _event of streamUpstream(protocol, request(overrides))) void _event
  return JSON.parse(captured || '{}') as Record<string, unknown>
}

describe('thinking levels on the wire', () => {
  it('sends nothing when the reader leaves the level on auto', async () => {
    const body = await sentBody('openai')
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('sends the one switch that actually stops a DeepSeek-style model, plus the effort name', async () => {
    const off = await sentBody('openai', { reasoning: 'off' })
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
    const low = await sentBody('openai', { reasoning: 'low' })
    expect(low.thinking).toEqual({ type: 'enabled' })
    expect(low.reasoning_effort).toBe('low')
    const high = await sentBody('openai', { reasoning: 'high' })
    expect(high.reasoning_effort).toBe('high')
  })

  it('gives Anthropic a budget under the answer ceiling and drops temperature while thinking', async () => {
    const on = await sentBody('anthropic', { reasoning: 'medium', maxOutputTokens: 4096 })
    expect(on.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 })
    expect(on.temperature).toBeUndefined()
    expect(on.max_tokens).toBe(4096)
    const off = await sentBody('anthropic', { reasoning: 'off' })
    expect(off.thinking).toBeUndefined()
    expect(off.temperature).toBe(0.2)
  })

  it('keeps a thinking budget at least at the vendor floor', async () => {
    const tight = await sentBody('anthropic', { reasoning: 'high', maxOutputTokens: 1200 })
    expect((tight.thinking as { budget_tokens: number }).budget_tokens).toBeGreaterThanOrEqual(1024)
    expect((tight.thinking as { budget_tokens: number }).budget_tokens).toBeLessThan(1200)
  })

  it('writes Gemini numbers, not names', async () => {
    const off = await sentBody('gemini', { reasoning: 'off' })
    expect((off.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 })
    const on = await sentBody('gemini', { reasoning: 'low' })
    expect((on.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true })
    const auto = await sentBody('gemini')
    expect((auto.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
  })
})

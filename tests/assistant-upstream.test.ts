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
import { reasoningDialect, reasoningRungs } from '../src/shared/reasoning'
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
    // Recorded through a property, not a local: `RequestInit.signal` is optional and nullable, and a
    // `let` assigned inside the stub kept being narrowed to its initializer, which hid the real shape.
    const seen: { signal?: AbortSignal | null } = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.signal = init.signal
      return response([openAiFrame({ content: 'x' })])
    }))
    const events: UpstreamEvent[] = []
    for await (const event of streamUpstream('openai', request({ signal: controller.signal }))) events.push(event)
    expect(events.length).toBe(1)
    expect(seen.signal).not.toBeUndefined()
    // Detaching the listener once the response began would leave a closed tab's stream running.
    controller.abort()
    expect(seen.signal?.aborted).toBe(true)
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

  it('keeps the field OpenAI documents, and only that field, on an endpoint that is not its own', async () => {
    // `api.openai.com` refuses a field it does not know, so one shape for every OpenAI-compatible server
    // is what used to make a reader's key fail on the service the protocol is named after.
    const official = await sentBody('openai', { reasoning: 'high', baseUrl: 'https://api.openai.com/v1' })
    expect(official.reasoning_effort).toBe('high')
    expect(official.thinking).toBeUndefined()
    const off = await sentBody('openai', { reasoning: 'off', baseUrl: 'https://api.openai.com/v1' })
    expect(off.reasoning_effort).toBe('none')
    expect(off.thinking).toBeUndefined()
    // An address nobody recognises keeps the same conservative shape, which is the one a server reads or
    // ignores rather than refuses.
    const unknown = await sentBody('openai', { reasoning: 'high' })
    expect(unknown.reasoning_effort).toBe('high')
    expect(unknown.thinking).toBeUndefined()
  })

  it('writes DeepSeek its own ladder, where the middle level is called high and max is the top', async () => {
    const deepseek = 'https://api.deepseek.com'
    const off = await sentBody('openai', { reasoning: 'off', baseUrl: deepseek })
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off.reasoning_effort).toBeUndefined()
    const medium = await sentBody('openai', { reasoning: 'medium', baseUrl: deepseek })
    expect(medium.thinking).toEqual({ type: 'enabled' })
    expect(medium.reasoning_effort).toBe('high')
    const high = await sentBody('openai', { reasoning: 'high', baseUrl: deepseek })
    expect(high.reasoning_effort).toBe('max')
  })

  it('finds the vendor behind a gateway from the model the gateway is asked for', async () => {
    const off = await sentBody('openai', { reasoning: 'off', baseUrl: 'https://api.siliconflow.com/v1', model: 'deepseek-ai/DeepSeek-V4-Flash' })
    expect(off.thinking).toEqual({ type: 'disabled' })
    const qwen = await sentBody('openai', { reasoning: 'off', baseUrl: 'https://api.cerebras.ai/v1', model: 'qwen-3.8-27b' })
    expect(qwen.enable_thinking).toBe(false)
  })

  it('gives Qwen its boolean switch rather than a budget its models bound differently', async () => {
    const dashscope = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    const on = await sentBody('openai', { reasoning: 'medium', baseUrl: dashscope })
    expect(on.enable_thinking).toBe(true)
    expect(on.thinking_budget).toBeUndefined()
    const off = await sentBody('openai', { reasoning: 'off', baseUrl: dashscope })
    expect(off.enable_thinking).toBe(false)
  })

  it('speaks OpenRouter its normalized reasoning object instead of the raw field', async () => {
    const openrouter = 'https://openrouter.ai/api/v1'
    const high = await sentBody('openai', { reasoning: 'high', baseUrl: openrouter })
    expect(high.reasoning).toEqual({ effort: 'high' })
    expect(high.reasoning_effort).toBeUndefined()
    const off = await sentBody('openai', { reasoning: 'off', baseUrl: openrouter })
    expect(off.reasoning).toEqual({ effort: 'none' })
  })

  it('gives Anthropic a budget under the answer ceiling and drops sampling while thinking', async () => {
    const on = await sentBody('anthropic', { reasoning: 'medium', maxOutputTokens: 4096, topP: 0.5 })
    expect(on.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 })
    expect(on.temperature).toBeUndefined()
    expect(on.top_p).toBeUndefined()
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

  it('sends the newest Claude the adaptive form, and no sampling setting at all', async () => {
    const newest = { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' }
    const on = await sentBody('anthropic', { ...newest, reasoning: 'high' })
    expect(on.thinking).toEqual({ type: 'adaptive' })
    expect(on.output_config).toEqual({ effort: 'high' })
    // Those models refuse a non-default temperature or top-p even when nothing was asked of their thinking.
    expect(on.temperature).toBeUndefined()
    expect(on.top_p).toBeUndefined()
    const off = await sentBody('anthropic', { ...newest, reasoning: 'off', topP: 0.5 })
    expect(off.thinking).toEqual({ type: 'adaptive' })
    expect(off.output_config).toEqual({ effort: 'low' })
    expect(off.temperature).toBeUndefined()
    const older = await sentBody('anthropic', { ...newest, model: 'claude-sonnet-4-5', reasoning: 'low' })
    expect((older.thinking as { budget_tokens: number }).budget_tokens).toBe(1024)
    expect(older.output_config).toBeUndefined()
  })

  it('writes Gemini numbers for a 2.5 model and levels for a 3.x one', async () => {
    const flash = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' }
    const off = await sentBody('gemini', { ...flash, reasoning: 'off' })
    expect((off.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 })
    const on = await sentBody('gemini', { ...flash, reasoning: 'low' })
    expect((on.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true })
    const auto = await sentBody('gemini', flash)
    expect((auto.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
    const three = await sentBody('gemini', { ...flash, model: 'gemini-3.8-flash', reasoning: 'low' })
    expect((three.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true })
    const threeHigh = await sentBody('gemini', { ...flash, model: 'gemini-3.8-flash', reasoning: 'high' })
    expect((threeHigh.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true })
  })

  it('does not ask a model that cannot stop thinking to stop', async () => {
    // A zero budget is refused by the Pro models, so the least they offer is sent instead of a request the
    // vendor would reject — and on 3.x that floor is `MINIMAL`, not off.
    const pro = await sentBody('gemini', { reasoning: 'off', model: 'gemini-2.5-pro' })
    expect((pro.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined()
    const three = await sentBody('gemini', { reasoning: 'off', model: 'gemini-3.8-flash' })
    expect((three.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' })
  })
})

describe('the thinking dialect a model speaks', () => {
  it('takes the vendor from the endpoint when the endpoint is the vendor\'s own', () => {
    expect(reasoningDialect('openai', 'https://api.openai.com/v1', 'gpt-5.4')).toBe('openai')
    expect(reasoningDialect('openai', 'https://api.deepseek.com', 'deepseek-chat')).toBe('deepseek')
    expect(reasoningDialect('openai', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus')).toBe('qwen')
    expect(reasoningDialect('openai', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-chat')).toBe('openrouter')
  })

  it('takes the vendor from the model id when the endpoint serves several', () => {
    expect(reasoningDialect('openai', 'https://api.together.xyz/v1', 'deepseek-ai/DeepSeek-V4-Pro-0813')).toBe('deepseek')
    expect(reasoningDialect('openai', 'https://api.cerebras.ai/v1', 'qwen-3.8-27b')).toBe('qwen')
    expect(reasoningDialect('openai', 'https://api.groq.com/openai/v1', 'gpt-oss-120b')).toBe('openai')
  })

  it('splits both versioned protocols inside one model generation', () => {
    expect(reasoningDialect('anthropic', 'https://api.anthropic.com/v1', 'claude-opus-4-7')).toBe('claude-effort')
    expect(reasoningDialect('anthropic', 'https://api.anthropic.com/v1', 'claude-sonnet-5.5')).toBe('claude-effort')
    expect(reasoningDialect('anthropic', 'https://api.anthropic.com/v1', 'claude-opus-4-6')).toBe('claude-budget')
    expect(reasoningDialect('anthropic', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet')).toBe('claude-budget')
    expect(reasoningDialect('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-3.1-pro')).toBe('gemini-level')
    expect(reasoningDialect('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-pro')).toBe('gemini-budget')
  })

  it('lets the provider pin settle the question for an address and a model that say nothing', () => {
    // A gateway on an internal host, forwarding to a vendor whose name is nowhere in the id: both readings
    // the inference has come out empty, which is exactly when the reader pins one.
    const address = 'https://gw.internal.example/v1'
    expect(reasoningDialect('openai', address, 'my-deployment')).toBe('openai')
    expect(reasoningDialect('openai', address, 'my-deployment', 'deepseek')).toBe('deepseek')
    // A pin also overrides a reading that would otherwise be right, because the reader is the one who knows
    // what is behind a proxy that renames the models it forwards.
    expect(reasoningDialect('openai', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-chat', 'qwen')).toBe('qwen')
  })

  it('falls back to the reading when the pin belongs to another wire', () => {
    // The dialects are not interchangeable across protocols, so a pin that no longer fits the wire is not
    // taken — the request path drops it too, rather than building a body the far end cannot read.
    expect(reasoningDialect('gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash', 'claude-effort')).toBe('gemini-budget')
  })

  it('offers each service its own levels rather than one list for all of them', () => {
    expect(reasoningRungs('claude-effort')).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(reasoningRungs('gemini-level')).toEqual(['auto', 'minimal', 'low', 'medium', 'high'])
    // Qwen's switch has no depth between off and on, so nothing is offered between those two rungs.
    expect(reasoningRungs('qwen')).toEqual(['auto', 'off'])
    // A dialect whose service cannot be stopped starts at its cheapest rung instead of offering off.
    expect(reasoningRungs('gemini-level')).not.toContain('off')
    expect(reasoningRungs('claude-effort')).not.toContain('off')
  })
})

describe('the web-search switch on the wire', () => {
  const searchNotes = { name: 'search_notes', description: 'd', parameters: { type: 'object' } }

  it('asks Anthropic for its own search tool, beside the function tools', async () => {
    const sent = await sentBody('anthropic', { webSearch: true, tools: [searchNotes] })
    const tools = sent.tools as { type?: string, name?: string, max_uses?: number }[]
    expect(tools.some((entry) => entry.type === 'web_search_20250305' && entry.name === 'web_search')).toBe(true)
    expect(tools.map((entry) => entry.name)).toContain('search_notes')
  })

  it('keeps the search tool out of Anthropic when the switch is off', async () => {
    const sent = await sentBody('anthropic', { tools: [searchNotes] })
    const tools = sent.tools as { name?: string }[]
    // Asserting only the absence would also pass when the whole tools key vanished.
    expect(tools.map((entry) => entry.name)).toEqual(['search_notes'])
    expect(JSON.stringify(sent.tools)).not.toContain('web_search')
  })

  it('adds Google grounding without dropping the function declarations', async () => {
    const sent = await sentBody('gemini', { webSearch: true, tools: [searchNotes] })
    const tools = sent.tools as { googleSearch?: unknown, functionDeclarations?: { name: string }[] }[]
    // Two keys in one object literal would have silently dropped one of them; both have to be present.
    expect(tools.some((entry) => entry.googleSearch !== undefined)).toBe(true)
    expect(tools.flatMap((entry) => entry.functionDeclarations ?? []).map((entry) => entry.name)).toEqual(['search_notes'])
  })

  it('still sends the grounding entry to Gemini when the turn has no function tools', async () => {
    const sent = await sentBody('gemini', { webSearch: true, tools: [] })
    expect(sent.tools).toEqual([{ googleSearch: {} }])
  })

  it('sends no invented field for openai, where the runner pins a tool instead', async () => {
    const sent = await sentBody('openai', { webSearch: true, tools: [searchNotes] })
    expect(JSON.stringify(sent)).not.toContain('web_search')
    expect((sent.tools as { function?: { name: string } }[]).map((entry) => entry.function?.name)).toEqual(['search_notes'])
  })
})

/**
 * The three ways a provider says "I ran out of output room".
 *
 * They arrive on different fields of different events, and each one missed is the same failure: an
 * answer that stops mid-sentence is streamed, stored and shown as if the model had finished it. A
 * thinking model makes that the common case rather than the rare one, because the trace is charged
 * against the same allowance as the answer.
 */
describe('the provider’s own output cap', () => {
  it('reads OpenAI-compatible `length` as a truncation', async () => {
    const events = await collect('openai', sseBody([openAiFrame({ content: 'half an ans' }, 'length')]))
    expect(events).toEqual([{ type: 'text', delta: 'half an ans' }, { type: 'truncated' }])
  })

  it('reads Anthropic `max_tokens` as a truncation', async () => {
    const events = await collect('anthropic', sseBody([
      data({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } }),
      // The stop reason shares an event with the answer's size, and the size only counts what was
      // generated; both have to be read off it without one hiding the other.
      data({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 4 } }),
      data({ type: 'message_stop' }),
    ]))
    expect(events).toContainEqual({ type: 'truncated' })
    expect(events).toContainEqual({ type: 'usage', inputTokens: 0, outputTokens: 4 })
  })

  it('reads Gemini `MAX_TOKENS` as a truncation', async () => {
    const events = await collect('gemini', sseBody([
      data({ candidates: [{ content: { parts: [{ text: 'half an ans' }] }, finishReason: 'MAX_TOKENS' }] }),
    ]))
    expect(events).toEqual([{ type: 'text', delta: 'half an ans' }, { type: 'truncated' }])
  })

  it('says nothing when the model stopped on its own', async () => {
    const events = await collect('openai', sseBody([
      openAiFrame({ content: 'all of it' }, 'stop'),
      data({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 3 } }),
    ]))
    expect(events.map((event) => event.type)).toEqual(['text', 'usage'])
  })
})

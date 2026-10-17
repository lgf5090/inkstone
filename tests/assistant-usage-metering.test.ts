// @vitest-environment node
/**
 * What a turn is charged for, and what it says about why it stopped.
 *
 * Three defects met in the same few lines. Every provider reports usage as a running total for the message
 * it belongs to, so a relay that repeats that total on every chunk turned "add whatever the wire says" into
 * billing one step a dozen times. A turn that was stopped or that died mid-flight was not charged at all,
 * although the model had already been paid for the tokens it produced — and the estimate that stands in for
 * a missing number never looked at the tool results, which are most of what a tool-heavy turn sends. And a
 * refusal or a safety block arrived as a finished answer, because only a cut-off at the output cap had a
 * channel of its own.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import { streamUpstream, type UpstreamEvent, type UpstreamRequest } from '../src/worker/assistant/upstream'
import type { Env } from '../src/worker/env'
import { estimateTokens, type AssistantMessage, type AssistantProtocol, type ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

function sse(frames: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

/** One answer chunk, with the running total a chatty relay hangs off it when it feels like it. */
const chunk = (text: string, usage?: { prompt_tokens: number, completion_tokens: number }) =>
  frame({ ...(usage ? { usage } : {}), choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })

const stop = (reason = 'stop') => frame({ choices: [{ index: 0, finish_reason: reason, delta: {} }] })
const toolCall = (name: string, usage?: { prompt_tokens: number, completion_tokens: number }) =>
  frame({
    ...(usage ? { usage } : {}),
    choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name, arguments: '{}' } }] } }],
  })
const toolStop = (usage?: { prompt_tokens: number, completion_tokens: number }) =>
  frame({ ...(usage ? { usage } : {}), choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] })

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // A provider with no key: `signKey` answers with an empty string, so nothing has to be decrypted for a
  // turn to reach the stubbed wire.
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

afterEach(() => vi.unstubAllGlobals())

// ------------------------------------------------------------------ the turn

async function newThread(title: string): Promise<{ conversationId: string, token: number }> {
  const conversation = await store.createConversation(title)
  const token = await store.claimRun(conversation.id)
  expect(token).not.toBeNull()
  return { conversationId: conversation.id, token: token! }
}

async function drive(conversationId: string, token: number, message: string): Promise<ChatStreamEvent[]> {
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
    runToken: token,
  })
  const events: ChatStreamEvent[] = []
  for await (const event of runner.chat({ conversationId, message, signal: new AbortController().signal })) {
    events.push(event)
  }
  return events
}

/**
 * A wire that answers each step from `replies` and keeps the bodies it was sent.
 *
 * The bodies are the point: an estimate is only right if it matches the prompt that actually left the
 * worker, and `onCall` is how a test takes the lease away or stops answering while a turn is mid-step.
 */
function stubWire(
  replies: readonly (readonly string[])[],
  options: { onCall?: (call: number) => void | Promise<void>, failOnCall?: number } = {},
): { requests: Record<string, unknown>[], calls: number } {
  const seen = { requests: [] as Record<string, unknown>[], calls: 0 }
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    seen.calls++
    await options.onCall?.(seen.calls)
    // Refused outright rather than dropped: a 400 is the one failure a turn does not retry, so the step
    // ends here instead of burning the caller's attempts on the same body.
    if (options.failOnCall === seen.calls) {
      return new Response(JSON.stringify({ error: { message: 'the provider went away' } }), { status: 400 })
    }
    const frames = replies[Math.min(seen.calls - 1, replies.length - 1)]!
    return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return seen
}

const endedWith = (events: ChatStreamEvent[]): AssistantMessage | undefined =>
  events.find((event) => event.type === 'done')?.finalMessage
const reportedUsage = (events: ChatStreamEvent[]) => events.find((event) => event.type === 'usage')?.usage

/**
 * The tokens a prompt really is, read off the body the model was sent.
 *
 * `system` plus every message it carries is exactly what the estimate is supposed to add up — including
 * the tool results, which ride as `role: 'tool'` messages rather than inside any turn's text.
 */
function promptTokens(body: Record<string, unknown>): number {
  const messages = (body.messages ?? []) as { content?: unknown }[]
  return estimateTokens(String(body.system ?? ''))
    + messages.reduce((total, message) => total + estimateTokens(typeof message.content === 'string' ? message.content : ''), 0)
}

/** Half an answer, streamed in more than sixteen pieces so the turn is stopped while it is still running. */
const LONG_ANSWER = Array.from({ length: 24 }, (_, index) => chunk(`part${index} `))

describe('a step that reports its running total on every frame', () => {
  it('charges one step once, however often the relay repeats the total', async () => {
    const { conversationId, token } = await newThread('Chatty relay')
    // The vendor's own numbers: cumulative within the message, so the last pair is the whole truth about
    // this step and every earlier pair is a prefix of it.
    stubWire([[chunk('Hel', { prompt_tokens: 100, completion_tokens: 1 }), chunk('lo', { prompt_tokens: 100, completion_tokens: 3 }), chunk('!', { prompt_tokens: 100, completion_tokens: 5 }), stop()]])

    const events = await drive(conversationId, token, 'Say hello.')
    const row = endedWith(events)!

    expect(reportedUsage(events)).toEqual({ inputTokens: 100, outputTokens: 5 })
    expect(row.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
    expect(await store.todayUsage()).toMatchObject({ inputTokens: 100, outputTokens: 5 })
  })

  it('adds the steps of one turn, because each step pays for its own prompt', async () => {
    const { conversationId, token } = await newThread('Two steps')
    stubWire([
      [toolCall('list_tasks', { prompt_tokens: 100, completion_tokens: 2 }), toolStop({ prompt_tokens: 100, completion_tokens: 4 })],
      [chunk('Nothing is on the list.', { prompt_tokens: 120, completion_tokens: 6 }), frame({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 8 } }), stop()],
    ])

    const events = await drive(conversationId, token, 'What is on my list?')
    const row = endedWith(events)!

    // 100/4 for the step that asked for the tool, 120/8 for the one that answered: the second prompt
    // carries the first plus the tool's result, and the provider charges for it again.
    expect(reportedUsage(events)).toEqual({ inputTokens: 220, outputTokens: 12 })
    expect(row.usage).toEqual({ inputTokens: 220, outputTokens: 12 })
  })
})

describe('a turn that never finished', () => {
  it('charges the tokens a failed turn already spent', async () => {
    const { conversationId, token } = await newThread('Provider died')
    // The first step answers with its numbers and a tool call; the second never gets served.
    const wire = stubWire(
      [[toolCall('list_tasks', { prompt_tokens: 100, completion_tokens: 4 }), toolStop({ prompt_tokens: 100, completion_tokens: 4 })], []],
      { failOnCall: 2 },
    )

    const events = await drive(conversationId, token, 'What is on my list?')
    const row = endedWith(events)!
    const today = await store.todayUsage()

    expect(row.status).toBe('error')
    // The turn ended on that refusal: a bad request is the one failure no second attempt is made for.
    expect(wire.calls).toBe(2)
    // What the wire did report before it died is real spend, and used to be thrown away with it.
    expect(row.usage).toEqual({ inputTokens: 100, outputTokens: 4 })
    expect(today).toMatchObject({ inputTokens: 100, outputTokens: 4, errors: 1 })
    // The turn's request quota is still spent where it always was — once for the turn, once for the step —
    // and metering the tokens must not become a third way to charge it.
    expect(today.requests).toBe(2)
  })

  it('charges the half of an answer the reader stopped', async () => {
    const { conversationId, token } = await newThread('Stopped mid-answer')
    let stolen: Promise<void> = Promise.resolve()
    const wire = stubWire([LONG_ANSWER], {
      onCall: () => {
        // The lease aged out and a second claim took the conversation, which is what a stop does to a turn
        // still streaming: the next lease check ends it.
        sqlite.prepare('UPDATE chat_active_runs SET lease_until = ?').run(1)
        stolen = store.claimRun(conversationId, Date.now() + 1).then(() => undefined)
      },
    })

    const events = await drive(conversationId, token, 'Tell me the whole story.')
    await stolen
    const row = endedWith(events)!

    expect(row.status).toBe('cancelled')
    expect(row.content).toContain('part0')
    // The stream died before it could price itself, so an estimate stands in. It is the prompt that was
    // actually sent, which is the only honest number available, and better than the nothing filed before.
    expect(row.usage).toEqual({
      inputTokens: promptTokens(wire.requests[0]!),
      outputTokens: estimateTokens(row.content),
    })
    expect(await store.todayUsage()).toMatchObject({
      inputTokens: promptTokens(wire.requests[0]!),
      outputTokens: estimateTokens(row.content),
    })
  })

  it('counts the tool results a turn was billed for', async () => {
    for (const index of [1, 2, 3]) {
      await store.createTask({ title: `Rent the deck ${index}`, description: 'Rebuilt every winter since the harbour was built in 1686 at the mouth of the bay, which is why the tide gates were replaced.'.repeat(2) })
    }
    const { conversationId, token } = await newThread('Tool heavy')
    // A wire that reports no numbers at all: the estimate is the only thing the reader's cost screen gets.
    const wire = stubWire([
      [toolCall('list_tasks'), toolStop()],
      [chunk('Noted.'), stop()],
    ])

    const events = await drive(conversationId, token, 'What is on my list?')
    const row = endedWith(events)!
    const toolText = ((wire.requests.at(-1)!.messages ?? []) as { role: string, content?: unknown }[])
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content))
      .join('')
    expect(toolText.length).toBeGreaterThan(500)

    expect(row.usage).toEqual({ inputTokens: promptTokens(wire.requests.at(-1)!), outputTokens: estimateTokens('Noted.') })
    expect((await store.todayUsage()).inputTokens).toBe(promptTokens(wire.requests.at(-1)!))
  })
})

// ------------------------------------------------------------------ stop reasons

const BASE = { baseUrl: 'https://api.example.com', apiKey: 'sk-test', model: 'm', signal: new AbortController().signal }

async function wire(protocol: AssistantProtocol, frames: readonly string[]): Promise<UpstreamEvent[]> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })))
  const request = {
    ...BASE,
    system: 'You are helpful.',
    turns: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'list_tasks', description: 'd', parameters: { type: 'object', properties: {} } }],
    maxOutputTokens: 512,
    temperature: 0.2,
    reasoning: 'auto',
  } as UpstreamRequest
  const events: UpstreamEvent[] = []
  for await (const event of streamUpstream(protocol, request)) events.push(event)
  return events
}

const stopReasonOf = (events: UpstreamEvent[]) => events.find((event) => event.type === 'stop-reason')

describe('why a stream stopped', () => {
  it('names a content filter on the openai-compatible wire', async () => {
    const events = await wire('openai', [chunk('I can’'), stop('content_filter')])
    expect(stopReasonOf(events)).toEqual({ type: 'stop-reason', reason: 'content_filter' })
    expect(events).not.toContainEqual({ type: 'truncated' })
  })

  it('names a refusal on the anthropic wire', async () => {
    const events = await wire('anthropic', [
      frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I can’' } }),
      frame({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 9 } }),
    ])
    expect(stopReasonOf(events)).toEqual({ type: 'stop-reason', reason: 'refusal' })
  })

  it('names a safety block on the gemini wire', async () => {
    const events = await wire('gemini', [
      frame({ candidates: [{ content: { parts: [{ text: 'I can’' }] }, finishReason: 'SAFETY' }] }),
    ])
    expect(stopReasonOf(events)).toEqual({ type: 'stop-reason', reason: 'safety' })
  })

  it('leaves a model that stopped on its own marker alone', async () => {
    const events = await wire('openai', [chunk('Done.'), stop('stop_sequence')])
    expect(stopReasonOf(events)).toBeUndefined()
    expect(events).not.toContainEqual({ type: 'truncated' })
  })

  it.each([
    ['content_filter', /content rules/],
    ['refusal', /declined/],
  ] as const)('files an answer cut short by %s as an error that says so', async (finishReason, notice) => {
    const { conversationId, token } = await newThread(`Blocked by ${finishReason}`)
    stubWire([[chunk('I can’'), stop(finishReason)]])

    const events = await drive(conversationId, token, 'Tell me about the harbour.')
    const row = endedWith(events)!

    expect(row.status).toBe('error')
    expect(row.error).toMatch(notice)
    // What did arrive stays: the reader sees where the answer stopped, and can ask for the rest.
    expect(row.content).toBe('I can’')
  })

  it('still files a plain stop as a finished answer', async () => {
    const { conversationId, token } = await newThread('Plain stop')
    stubWire([[chunk('The harbour was built in 1686.'), stop()]])

    const events = await drive(conversationId, token, 'Tell me about the harbour.')

    expect(endedWith(events)!.status).toBe('complete')
    expect(endedWith(events)!.error).toBe(null)
  })
})

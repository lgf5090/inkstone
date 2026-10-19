// @vitest-environment node
/**
 * What a turn is shown of its own thread, and what it says about how it ended.
 *
 * Five things were quietly untrue, all of them in the part of a turn the reader cannot see without
 * instrumenting it. The history was budgeted against the model's whole context while the same prompt still
 * owed room for its own answer and for the tool results later steps read back into it — so the arithmetic
 * contradicted the ceiling it was measuring, and the provider's refusal was the reader's error. The summary
 * mark was a millisecond, and two turns written inside one were indistinguishable to it, so a roll-up could
 * swallow the question being answered. An old tool call was replayed as `{"ok":true}`, which tells the model
 * it retrieved nothing, so it retrieved it again. A turn that ran out of steps was filed as a finished
 * answer, and a turn that ran out of steps with nothing written was given a "Done." the model never wrote.
 * And a citation list was whatever the vendor decided to send.
 *
 * Each case is read off the body that actually left the worker, or off the row actually filed, because every
 * one of them is a claim about what the model saw or what the reader was told — and a test that only reads
 * the answer would pass on all five.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner, buildContextWindow } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { contextBudgetFor, estimateTokens, type AssistantMessage, type AssistantSettings, type ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'

const USER = '0123456789abcdefghjkmnpqrs'

/**
 * The bounds `runner.ts` keeps to itself (`MAX_TURN_SOURCES`, `MAX_SOURCE_URL_CHARS`,
 * `MAX_HISTORY_TOOL_RESULT_CHARS`), spelled out here rather than imported: the promise being tested is the
 * size of a stored row, and a test that read its ceiling from the code that sets it could not notice the
 * ceiling being raised.
 */
const CAP_SOURCES = 20
const CAP_SOURCE_URL_CHARS = 2_000
const CAP_REPLAYED_RESULT_CHARS = 2_000

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
const chunk = (text: string, deltaExtra?: Record<string, unknown>) =>
  frame({ choices: [{ index: 0, finish_reason: null, delta: { content: text, ...(deltaExtra ?? {}) } }] })
const stop = (reason = 'stop') => frame({ choices: [{ index: 0, finish_reason: reason, delta: {} }] })
const toolCall = (name: string, id = 'c1') =>
  frame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] } }] })
const toolStop = () => stop('tool_calls')

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let providerId: string

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // A provider with no key at all: `signKey` answers with an empty string, so nothing has to be decrypted
  // for a turn to reach the stubbed wire.
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  providerId = provider.id
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', maxOutputTokens: 64 })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ------------------------------------------------------------------ harness

async function newThread(title: string): Promise<{ conversationId: string, token: number }> {
  const conversation = await store.createConversation(title)
  const token = await store.claimRun(conversation.id)
  expect(token).not.toBeNull()
  return { conversationId: conversation.id, token: token! }
}

/**
 * A wire that answers each call in order and keeps the bodies it was sent.
 *
 * `refuse` is the call number that answers with a 400 instead of a stream: a refusal at the door is the one
 * failure no second attempt is made for, so a roll-up that cannot be written fails on the spot and leaves
 * the turn to go on without it.
 */
function stubWire(
  replies: readonly (readonly string[])[],
  options: { refuse?: number } = {},
): { requests: Record<string, unknown>[], calls: () => number } {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    // The follow-up pass that runs after the answer is filed is not one of this turn's calls.
    if (isNamingRequest(body)) return namingAnswer()
    requests.push(body)
    if (options.refuse === requests.length) {
      return new Response(JSON.stringify({ error: { message: 'the summariser is not answering' } }), { status: 400 })
    }
    const frames = replies[Math.min(requests.length - 1, replies.length - 1)]!
    return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return { requests, calls: () => requests.length }
}

async function drive(
  conversationId: string,
  token: number,
  message: string,
  settings?: AssistantSettings,
): Promise<ChatStreamEvent[]> {
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: settings ?? await store.getSettings(),
    runToken: token,
  })
  const events: ChatStreamEvent[] = []
  for await (const event of runner.chat({ conversationId, message, signal: new AbortController().signal })) {
    events.push(event)
  }
  return events
}

const endedWith = (events: ChatStreamEvent[]): AssistantMessage | undefined =>
  events.find((event) => event.type === 'done')?.finalMessage

/**
 * The tokens a prompt really is, read off the body the model was sent.
 *
 * `system` plus every message it carries, including the `role: 'tool'` ones that hold a tool's answer —
 * which is what a budget has to cover, and the number the window was supposed to have left room for.
 */
function promptTokens(body: Record<string, unknown>): number {
  const messages = (body.messages ?? []) as { content?: unknown }[]
  return messages.reduce(
    (total, message) => total + estimateTokens(typeof message.content === 'string' ? message.content : ''),
    estimateTokens(String(body.system ?? '')),
  )
}

/** History that will not fit, in rows big enough for the budget to be the only thing deciding that. */
async function seedLongHistory(conversationId: string, count: number, createdAt?: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await store.addMessage({
      conversationId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${'tide gates'.repeat(400)} ${index}`,
      ...(createdAt === undefined ? {} : { createdAt }),
    })
  }
}

const toolMessages = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as { role: string, content?: unknown }[]).filter((message) => message.role === 'tool')

const userTexts = (body: Record<string, unknown>) =>
  ((body.messages ?? []) as { role: string, content?: unknown }[])
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content))

// ------------------------------------------------------------------ the budget

describe('the room a turn leaves for itself', () => {
  /**
   * A 4096-token answer asked for inside a 32768-token window, over more history than either budget holds.
   *
   * The old arithmetic cut history at `window - system - 600`, which left the prompt the whole window minus
   * six hundred tokens and then added a 4096-token answer to it: the bound below is exactly that, so this
   * case fails by a wide margin on the old numbers and passes with a thousand tokens to spare on the new.
   */
  it('leaves the output allowance outside the history budget', async () => {
    const small = await store.createModel({
      providerId,
      model: 'wide-model',
      label: 'Wide window',
      maxOutputTokens: 4_096,
      contextTokens: 32_768,
    })
    const settings = { ...(await store.getSettings()), activeModelId: small.id }
    await store.saveSettings(settings)
    const { conversationId, token } = await newThread('Wide window')
    await seedLongHistory(conversationId, 40)
    // The roll-up is refused on purpose: with no summary written the window is never rebuilt, so what was
    // sent is exactly what the budget under test chose.
    const wire = stubWire([[chunk('Condensed: the thread is about tide gates.'), stop()], [chunk('The tide gates were replaced in 1902.'), stop()]], { refuse: 1 })

    await drive(conversationId, token, 'When were the tide gates replaced?', settings)
    const body = wire.requests.at(-1)!

    const budget = contextBudgetFor(small, settings.limits)
    expect(promptTokens(body) + (small.maxOutputTokens ?? 0)).toBeLessThanOrEqual(budget)
  })

  it('still counts the tool results a step reads back into the same prompt', async () => {
    // The reserve is what keeps the budget honest past the first step: a turn that ran a tool sent the
    // result as its own message, and the window had never been told that message was coming.
    const small = await store.createModel({
      providerId,
      model: 'wide-model',
      label: 'Wide window',
      maxOutputTokens: 4_096,
      contextTokens: 32_768,
    })
    const settings = { ...(await store.getSettings()), activeModelId: small.id }
    await store.saveSettings(settings)
    const { conversationId, token } = await newThread('Two steps')
    await seedLongHistory(conversationId, 30)
    const wire = stubWire([
      [toolCall('list_tasks'), toolStop()],
      [chunk('Noted.'), stop()],
    ])

    await drive(conversationId, token, 'What is on my list?', settings)

    // The second step re-sends the first plus the tool's answer. Both prompts are what the budget had to
    // cover, and neither may be over the window once its own answer allowance is counted.
    for (const body of wire.requests) {
      expect(promptTokens(body) + (small.maxOutputTokens ?? 0)).toBeLessThanOrEqual(contextBudgetFor(small, settings.limits))
    }
  })
  it('prices the results an old turn carries, not only its words', () => {
    // A few words of answer with a whole listing behind them: the listing goes out again in every later
    // prompt, so it is part of what the window is paying for, and the row that hides it is the one that
    // overruns the model.
    const window = buildContextWindow(
      [
        { role: 'user', content: 'asked long ago', createdAt: 1 },
        { role: 'assistant', content: 'I found some notes.', createdAt: 2, calls: [{ id: 'c1', name: 'search_notes', args: {}, result: 'tide gates '.repeat(2_000), error: false }] },
        { role: 'user', content: 'the newest question', createdAt: 3 },
      ],
      200,
      null,
    )
    expect(window.messages.map((entry) => entry.content)).toEqual(['the newest question'])
    expect(window.overflow).toHaveLength(2)
  })
})

// ------------------------------------------------------------------ the summary mark

describe('the mark a roll-up was cut at', () => {
  it('keeps a row written in the same millisecond as the mark', () => {
    // The mark names the row it was taken from. Everything at that millisecond which is not that row came
    // after the history the summary describes, and dropping it discards the reader's newest words.
    const window = buildContextWindow(
      [
        { role: 'user', content: 'older question', createdAt: 10, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { role: 'assistant', content: 'the answer that was condensed', createdAt: 20, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' },
        { role: 'user', content: 'asked in the same millisecond', createdAt: 20, id: 'cccccccccccccccccccccccccc' },
      ],
      4_000,
      20,
      'bbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(window.messages.map((entry) => entry.content)).toEqual(['asked in the same millisecond'])
    expect(window.overflow).toEqual([])
  })

  it('keeps folding the marked row itself away, and everything before it', () => {
    const window = buildContextWindow(
      [
        { role: 'user', content: 'folded', createdAt: 10, id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { role: 'assistant', content: 'the marked row', createdAt: 20, id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb' },
      ],
      4_000,
      20,
      'bbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(window.messages).toEqual([])
  })

  it('carries the newest question into the turn whose history it condensed', async () => {
    // The turn that writes the mark is the one that can lose a row to it: every row of a transcript
    // restored in one instant shares that millisecond, and the question asked next does too.
    const at = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(at)
    const { conversationId, token } = await newThread('One instant')
    await seedLongHistory(conversationId, 24, at)
    const wire = stubWire([
      [chunk('Condensed: a long thread about tide gates.'), stop()],
      [chunk('The gates were replaced in 1902.'), stop()],
    ])

    const events = await drive(conversationId, token, 'Which year were the tide gates replaced?')

    expect(endedWith(events)?.status).toBe('complete')
    // The request the model actually answered: the second one, rebuilt under the mark the first roll-up left.
    const body = wire.requests.at(-1)!
    expect(userTexts(body).join('\n')).toContain('Which year were the tide gates replaced?')
  })
})

// ------------------------------------------------------------------ replayed tool results

describe('an old tool call shown to the model again', () => {
  const LONG_RESULT = `${'the deck faces the harbour and the tide gates were rebuilt every winter | '.repeat(120)}untouched since`

  async function threadWithACall(): Promise<string> {
    const conversation = await store.createConversation('Searched before')
    await store.addMessage({ conversationId: conversation.id, role: 'user', content: 'List my notes about the harbour.' })
    await store.addMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: 'I found three notes about the harbour.',
      tools: [
        { id: 'c1', name: 'search_notes', status: 'success', args: '{}', result: LONG_RESULT },
        { id: 'c2', name: 'read_note', status: 'error', error: 'That note is not in your scope.' },
      ],
    })
    return conversation.id
  }

  it('sends what the call brought back, not a made-up success', async () => {
    const conversationId = await threadWithACall()
    const wire = stubWire([[chunk('The harbour notes mention the 1902 rebuild.'), stop()]])
    const token = await store.claimRun(conversationId)
    expect(token).not.toBeNull()

    const events = await drive(conversationId, token!, 'What did they say about the rebuild?')

    expect(endedWith(events)?.status).toBe('complete')
    const replayed = toolMessages(wire.requests[0]!).map((message) => String(message.content))
    expect(replayed).toHaveLength(2)
    // Real words from the earlier answer, so the model knows it has already retrieved them.
    expect(replayed[0]).toContain('the deck faces the harbour')
    expect(replayed[0]).not.toContain('{"ok":true}')
    // Clipped: the row keeps a whole payload for the reader's chip, and a later turn must not buy all of
    // it back on every step.
    expect(replayed[0]!.length).toBeLessThan(CAP_REPLAYED_RESULT_CHARS + 60)
    expect(replayed[0]).toContain('more characters')
    // A failure still names itself, which is the part the model has to know before it tries anything.
    expect(replayed[1]).toContain('That note is not in your scope.')
  })

  it('does not strand a turn that repeats a call inside itself', async () => {
    // The duplicate refusal lives in one turn's executor, so a replayed history result cannot collide with
    // it; a model that repeats itself is told so in the tool's own answer and the turn still finishes.
    const { conversationId, token } = await newThread('Repeats itself')
    const wire = stubWire([
      [toolCall('list_tasks', 'c1'), toolStop()],
      [toolCall('list_tasks', 'c2'), toolStop()],
      [chunk('Nothing is on the list.'), stop()],
    ])

    const events = await drive(conversationId, token, 'What is on my list?')
    const row = endedWith(events)!

    expect(wire.calls()).toBe(3)
    expect(row.status).toBe('complete')
    expect(row.content).toBe('Nothing is on the list.')
    // The third prompt is where the refusal lands: the second one only carries the first call's own result.
    const repeated = toolMessages(wire.requests[2]!).map((message) => String(message.content))
    expect(repeated.join('\n')).toContain('already made in this request')
  })
})

// ------------------------------------------------------------------ how a turn is filed

describe('a turn that ran out of room to keep going', () => {
  /** The step ceiling, so the next step is never taken and the turn ends mid-work. */
  const oneStep = async (): Promise<AssistantSettings> => {
    const settings = await store.getSettings()
    const limited = { ...settings, limits: { ...settings.limits, maxAgentSteps: 1 } }
    await store.saveSettings(limited)
    return limited
  }

  it('files a stopped step loop as unfinished, and keeps the words', async () => {
    const settings = await oneStep()
    stubWire([[chunk('First I will look that up. '), toolCall('list_tasks'), toolStop()], [chunk('Never reached.'), stop()]])
    const { conversationId, token } = await newThread('One step only')

    const row = endedWith(await drive(conversationId, token, 'What is on my list?', settings))!

    expect(row.status).toBe('error')
    expect(row.error).toMatch(/step limit/)
    expect(row.content).toBe('First I will look that up. ')
    // Filed the way a cut-off answer is: the reader can ask for the rest of it.
    expect(row.content.trim().length).toBeGreaterThan(0)
  })

  it('names the tool-call ceiling when that is what ran out', async () => {
    const settings = await store.getSettings()
    const limited = { ...settings, limits: { ...settings.limits, maxToolCalls: 1 } }
    await store.saveSettings(limited)
    stubWire([[toolCall('list_tasks'), toolStop()], [chunk('Never reached.'), stop()]])
    const { conversationId, token } = await newThread('One call only')

    const row = endedWith(await drive(conversationId, token, 'What is on my list?', limited))!

    expect(row.status).toBe('error')
    expect(row.error).toMatch(/tool-call limit/)
  })

  it('invents no closing sentence for a turn that wrote none', async () => {
    // The model answered with a tool and then with nothing at all. "Done." used to be written here: a
    // sentence the model never produced, filed as a finished answer, and read back by the next turn as its
    // own last words.
    const { conversationId, token } = await newThread('Silent after the tools')
    stubWire([[toolCall('list_tasks'), toolStop()], [stop()]])

    const row = endedWith(await drive(conversationId, token, 'What is on my list?'))!

    expect(row.status).toBe('error')
    expect(row.content).toBe('')
    expect(row.error).toMatch(/ran its tools/)
    expect(JSON.stringify(row)).not.toContain('Done.')
  })

  it('still files a plain stop with an answer in it as complete', async () => {
    const { conversationId, token } = await newThread('Plain stop')
    stubWire([[chunk('The harbour was built in 1686.'), stop()]])

    const row = endedWith(await drive(conversationId, token, 'Tell me about the harbour.'))!

    expect(row.status).toBe('complete')
    expect(row.error).toBe(null)
  })
})

// ------------------------------------------------------------------ citations

describe('the pages an upstream names', () => {
  it('keeps one turn’s citations inside the row’s bounds', async () => {
    const { conversationId, token } = await newThread('A very helpful vendor')
    const annotations = [
      ...Array.from({ length: CAP_SOURCES + 30 }, (_, index) => ({
        type: 'url_citation',
        url_citation: { url: `https://example.com/harbour/${index}`, title: `Note ${index}` },
      })),
      // One address longer than any reader needs to be made to carry in a transcript row forever.
      { type: 'url_citation', url_citation: { url: `https://example.com/${'q'.repeat(6_000)}`, title: 'Endless' } },
    ]
    const wire = stubWire([[chunk('The gates were replaced in 1902.', { annotations }), stop()]])

    const row = endedWith(await drive(conversationId, token, 'When were the gates replaced?'))!

    expect(wire.calls()).toBe(1)
    const stored = JSON.parse(String((sqlite.prepare('SELECT sources FROM chat_messages WHERE id = ?').get(row.id) as { sources: string }).sources)) as { url: string }[]
    expect(stored.length).toBeLessThanOrEqual(CAP_SOURCES)
    expect(stored.length).toBeGreaterThan(0)
    for (const source of stored) expect(source.url.length).toBeLessThanOrEqual(CAP_SOURCE_URL_CHARS)
    // The shape the cards are rendered from is unchanged.
    expect(stored[0]).toMatchObject({ url: 'https://example.com/harbour/0', title: 'Note 0' })
  })
})

// ------------------------------------------------------------------ the roll-up that did not happen

describe('a conversation whose older turns could not be condensed', () => {
  it('says so instead of answering as though it had the whole thread', async () => {
    const { conversationId, token } = await newThread('Summariser down')
    await seedLongHistory(conversationId, 20)
    stubWire([[chunk('unused'), stop()], [chunk('The gates were replaced in 1902.'), stop()]], { refuse: 1 })

    const events = await drive(conversationId, token, 'When were the gates replaced?')

    const notice = events.find((event) => event.type === 'error' && event.code === 'summary_unavailable')
    expect(notice?.message).toMatch(/could not condense/)
    // The answer itself is still good, and still filed as one.
    expect(endedWith(events)?.status).toBe('complete')
  })

  it('says nothing when the roll-up went through', async () => {
    const { conversationId, token } = await newThread('Summariser up')
    await seedLongHistory(conversationId, 20)
    stubWire([
      [chunk('Condensed: a long thread about the harbour.'), stop()],
      [chunk('The gates were replaced in 1902.'), stop()],
    ])

    const events = await drive(conversationId, token, 'When were the gates replaced?')

    expect(events.some((event) => event.type === 'error' && event.code === 'summary_unavailable')).toBe(false)
    expect((await store.getConversation(conversationId))?.summary).toContain('harbour')
  })
})

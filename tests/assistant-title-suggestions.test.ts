// @vitest-environment node
/**
 * The naming pass: one cheap call after a fresh conversation's first answer that titles the thread from the
 * model rather than from the reader's first line, and volunteers the three follow-up questions the reader can
 * tap next.
 *
 * Four promises are pinned here, and each is the one that is easiest to break by accident:
 *  - the call runs once, only for a brand-new kept conversation whose answer filed whole, on the same model and
 *    through the existing structured-output wire — never on a later turn (its title already belongs to the reader),
 *    never on an ephemeral comparison thread (nobody will ever see its title);
 *  - it is metered — the tokens land on the day's totals and the model's cost row like any other spend, so the
 *    reader is not quietly burned — yet they are NOT folded into the turn's own usage row, which answers a
 *    different question ("what did this reply cost") than the naming pass ("what did naming it cost");
 *  - when it fails in any way — refused, timed out, not JSON — the derived title stands, no suggestions are
 *    shown, and no rename is claimed, because a title that did not happen must not look like it did;
 *  - the suggestions are this account's, stored on the answer that produced them: another account cannot read
 *    or overwrite them, and only the first answer of the thread ever carries them.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import { estimateTokens, titleFromMessage, type ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = 'ssssssssssssssssssssssssss'

let sqlite: DatabaseSync
let env: ReturnType<typeof testBindings>
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
const chunk = (text: string, usage?: { prompt_tokens: number, completion_tokens: number }) =>
  frame({ ...(usage ? { usage } : {}), choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })
const stop = () => frame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] })

const NAMED = {
  title: 'Harbour history',
  suggestions: ['When was the harbour built?', 'Why were the tide gates replaced?', 'Who funded it?'],
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

afterEach(() => vi.unstubAllGlobals())

function stubWire(
  replies: readonly (readonly string[])[],
  options: { failOnCall?: number } = {},
): { requests: Record<string, unknown>[], calls: number } {
  const seen = { requests: [] as Record<string, unknown>[], calls: 0 }
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    seen.calls++
    if (options.failOnCall === seen.calls) {
      return new Response(JSON.stringify({ error: { message: 'the provider went away' } }), { status: 400 })
    }
    const frames = replies[Math.min(seen.calls - 1, replies.length - 1)]!
    return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
  }))
  return seen
}

/** Answer a message with no conversation id, so the turn makes (and names) the thread itself. */
async function driveNew(message: string): Promise<{ events: ChatStreamEvent[], conversationId: string }> {
  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
  })
  const events: ChatStreamEvent[] = []
  let conversationId = ''
  for await (const event of runner.chat({ message, signal: new AbortController().signal })) {
    events.push(event)
    if (event.type === 'start' && event.conversationId) conversationId = event.conversationId
  }
  return { events, conversationId }
}

async function driveExisting(conversationId: string, message: string): Promise<ChatStreamEvent[]> {
  const token = await store.claimRun(conversationId)
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
  await store.releaseRun(conversationId, token ?? undefined)
  return events
}

const answerFrames = (text: string) => [chunk(text, { prompt_tokens: 100, completion_tokens: 5 }), stop()]
const namingFrames = (obj: unknown) => [chunk(JSON.stringify(obj), { prompt_tokens: 40, completion_tokens: 20 }), stop()]
/** Every `title` frame the turn sent, in the order the reader was handed them. */
const titleFrames = (events: ChatStreamEvent[]) => events.filter((e) => e.type === 'title')
const titlesSent = (events: ChatStreamEvent[]) => titleFrames(events).map((e) => e.title)

describe('a fresh conversation names itself and offers follow-ups', () => {
  it('renames the thread to the model title and stores the suggestions on the answer', async () => {
    const wire = stubWire([answerFrames('The harbour was built in 1686 at the mouth of the bay.'), namingFrames(NAMED)])

    const { events, conversationId } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    // The model title wins over the truncation of the first line, and it is announced a second time so the
    // list refreshes to the name the model actually chose.
    expect((await store.getConversation(conversationId))!.title).toBe(NAMED.title)
    expect(titlesSent(events)).toEqual([titleFromMessage('Tell me about the harbour.'), NAMED.title])
    // The second frame is what the transcript puts the chips under the right answer with: it names the row
    // they were stored on as well as the thread they were named for.
    expect(titleFrames(events)[1]).toMatchObject({
      conversationId,
      assistantMessageId: row.id,
      title: NAMED.title,
      suggestions: NAMED.suggestions,
    })

    // The follow-ups ride on the answer that produced them, read back through the scoped message path.
    const stored = await store.getMessage(row.id)
    expect(stored!.suggestions).toEqual(NAMED.suggestions)

    // Two calls left the worker: the answer, then one naming pass that asked the wire for JSON on the same model.
    expect(wire.calls).toBe(2)
    expect(wire.requests[1]).toMatchObject({ response_format: { type: 'json_object' } })
    expect(wire.requests[1]!.model).toBe('example-model')
  })

  it('meters the naming pass without folding it into the turn’s own usage', async () => {
    stubWire([answerFrames('The harbour was built in 1686.'), namingFrames(NAMED)])

    const { events } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    // The turn's row reports only the turn: 100/5, exactly the answer's own tokens.
    expect(row.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
    expect((await store.getMessage(row.id))!.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
    // The `usage` frame the reader was billed for on screen never saw the naming tokens either.
    expect(events.find((e) => e.type === 'usage')!.usage).toEqual({ inputTokens: 100, outputTokens: 5 })

    // Day totals do see them — the naming call really spent 40/20 and two requests, so it is not free.
    expect(await store.todayUsage()).toMatchObject({ inputTokens: 140, outputTokens: 25, requests: 2 })

    // The model's own cost row carries the combined spend and an attributed model id, so the per-model
    // screen can price the naming pass rather than drop it.
    const modelRow = sqlite.prepare(
      `SELECT model_label, model_id, input_tokens, output_tokens FROM chat_usage_daily_model`,
    ).all() as { model_label: string, model_id: string | null, input_tokens: number, output_tokens: number }[]
    expect(modelRow).toHaveLength(1)
    expect(modelRow[0]).toMatchObject({ model_label: 'Example one', input_tokens: 140, output_tokens: 25 })
    expect(modelRow[0]!.model_id).not.toBeNull()
  })

  it('trims a too-long title and an overfilled suggestion list instead of rejecting the whole answer', async () => {
    const longTitle = 'A'.repeat(300)
    stubWire([
      answerFrames('The harbour was built in 1686.'),
      namingFrames({ title: longTitle, suggestions: ['one', 'two', 'three', 'four', 'five', '  ', 'one'] }),
    ])

    const { events, conversationId } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    // Bounded to the column the list already enforces, not refused outright.
    expect((await store.getConversation(conversationId))!.title).toBe(longTitle.slice(0, 200))
    // At most three, deduped, empties dropped — the pass is trimmed to what the footline can show, not rejected.
    expect((await store.getMessage(row.id))!.suggestions).toEqual(['one', 'two', 'three'])
  })

  it('keeps the suggestions from a partial answer that named nothing', async () => {
    // A model that offers follow-ups but leaves the title blank: the derived title stands, the chips still land.
    stubWire([answerFrames('The harbour was built in 1686.'), namingFrames({ title: '', suggestions: ['Only one?'] })])

    const { events, conversationId } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    expect((await store.getConversation(conversationId))!.title).toBe(titleFromMessage('Tell me about the harbour.'))
    // The follow-ups are worth a frame on their own: a pass that offered questions but named nothing still
    // reaches the screen, and it says no rename happened by carrying no title.
    expect(titlesSent(events)).toEqual([titleFromMessage('Tell me about the harbour.'), undefined])
    const followUps = titleFrames(events)[1]!
    expect(followUps.suggestions).toEqual(['Only one?'])
    expect(followUps.assistantMessageId).toBe(row.id)
    expect((await store.getMessage(row.id))!.suggestions).toEqual(['Only one?'])
  })

  it('delivers the follow-ups when the reader renamed the thread while the pass was in flight', async () => {
    // The race the rename check is for: a second tab gives the thread the reader's own name between the
    // turn filing and the pass writing back. Their name stands, and the questions still reach the answer
    // they were written for — the two halves of the frame are independent precisely because this happens.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      const naming = request.response_format !== undefined
      if (naming) {
        const [{ id }] = sqlite.prepare('SELECT id FROM chat_conversations').all() as { id: string }[]
        await store.renameConversation(id, 'Harbour, as I named it')
      }
      return new Response(sse(naming
        ? namingFrames({ title: 'Harbour history', suggestions: ['And the gates?'] })
        : answerFrames('The harbour was built in 1686.')), { headers: { 'content-type': 'text/event-stream' } })
    }))

    const { events, conversationId } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    expect((await store.getConversation(conversationId))!.title).toBe('Harbour, as I named it')
    expect(titlesSent(events)).toEqual([titleFromMessage('Tell me about the harbour.'), undefined])
    expect(titleFrames(events)[1]!.suggestions).toEqual(['And the gates?'])
    expect((await store.getMessage(row.id))!.suggestions).toEqual(['And the gates?'])
  })
})

describe('a naming pass that does not land', () => {
  it('leaves the derived title and shows no suggestions when the call is refused', async () => {
    // The answer arrives whole (call 1), the naming pass is refused (call 2).
    stubWire([answerFrames('The harbour was built in 1686.'), []], { failOnCall: 2 })

    const { events, conversationId } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    // The honest reading: the thread keeps the name it was derived, and no second title is claimed.
    expect((await store.getConversation(conversationId))!.title).toBe(titleFromMessage('Tell me about the harbour.'))
    expect(titlesSent(events)).toEqual([titleFromMessage('Tell me about the harbour.')])
    expect((await store.getMessage(row.id))!.suggestions).toBeUndefined()
    // The attempt is still metered as an error, so a silently-dead pass is visible on the cost screen.
    expect((await store.todayUsage()).errors).toBe(1)
  })

  it('leaves the derived title when the model answers with prose that holds no object', async () => {
    stubWire([answerFrames('The harbour was built in 1686.'), [chunk('I am not sure how to name this one.'), stop()]])

    const { conversationId } = await driveNew('Tell me about the harbour.')

    expect((await store.getConversation(conversationId))!.title).toBe(titleFromMessage('Tell me about the harbour.'))
  })

  it('names nothing for a later turn of an existing conversation', async () => {
    // A thread that already exists is already named: a second answer must neither re-title it nor spend a call.
    const conversation = await store.createConversation('A named thread')
    const wire = stubWire([answerFrames('The tide gates were replaced in 1902.')])

    const events = await driveExisting(conversation.id, 'And the gates?')

    expect(wire.calls).toBe(1)
    expect(titlesSent(events)).toEqual([])
    expect((await store.getConversation(conversation.id))!.title).toBe('A named thread')
    expect((events.find((e) => e.type === 'done')!.finalMessage!.suggestions)).toBeUndefined()
  })

  it('never asks a model in offline mode', async () => {
    // Offline answers through `offlineTurn`, which has no naming pass: a fetch attempt here would be a call
    // to a model that does not exist, so the stub throws if it is reached at all.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline mode must not call a model') }))
    const conversation = await store.createConversation(titleFromMessage('Offline plan'))

    const runner = new AssistantRunner({
      store,
      env,
      ftsEnabled: false,
      origin: 'http://localhost',
      settings: await store.getSettings(),
    })
    const reply = await runner.offlineTurn(conversation.id, 'Offline plan')

    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(reply.suggestions).toBeUndefined()
    expect((await store.getConversation(conversation.id))!.title).toBe(titleFromMessage('Offline plan'))
  })
})

describe('another account cannot read or write the follow-ups', () => {
  it('reads nothing and writes nothing across the tenant line', async () => {
    stubWire([answerFrames('The harbour was built in 1686.'), namingFrames(NAMED)])
    const { events } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    const other = new AssistantStore(env.DB as D1Database, OTHER, env)

    // A scoped read: the answer is not the other account's row to see.
    expect(await other.getMessage(row.id)).toBeNull()
    // A scoped write: it is not the other account's row to overwrite either.
    expect(await other.setMessageSuggestions(row.id, ['stolen'])).toBe(false)
    // And the owner's chips are untouched by the attempt.
    expect((await store.getMessage(row.id))!.suggestions).toEqual(NAMED.suggestions)
  })
})

/**
 * The estimate fallback path. A relay that reports no usage on the naming stream still has to be priced, so
 * the tokens are estimated from the prompt that left the worker rather than filed as free.
 */
describe('a naming stream that reports no usage', () => {
  it('estimates the spend instead of leaving the pass unbilled', async () => {
    const bare = [chunk(JSON.stringify(NAMED)), stop()]
    stubWire([answerFrames('The harbour was built in 1686.'), bare])

    const { events } = await driveNew('Tell me about the harbour.')
    const row = events.find((e) => e.type === 'done')!.finalMessage!

    // The turn's own row is still the turn's (100/5); the naming estimate lands on the day totals on top of it.
    expect(row.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
    const day = await store.todayUsage()
    expect(day.inputTokens).toBeGreaterThan(100)
    expect(day.outputTokens).toBeGreaterThan(5)
    expect(day.requests).toBe(2)
    expect(day.inputTokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(NAMED)) + 100)
  })
})

describe('the suggestions column keeps both sides of a restore in step', () => {
  it('carries the chips through export and import, and drops a row whose NOT NULL key is left out', async () => {
    stubWire([answerFrames('The harbour was built in 1686.'), namingFrames(NAMED)])
    const { events } = await driveNew('Tell me about the harbour.')
    const rowId = events.find((e) => e.type === 'done')!.finalMessage!.id

    // The column rides in `exportTables` (a `SELECT *`), so the backup file carries it as a JSON string.
    const exported = (await store.exportTables()).messages.find((m) => m.id === rowId)!
    expect(typeof exported.suggestions).toBe('string')

    // Restored into a fresh account through the same allowlist, the chips come back on the row.
    const restored = new AssistantStore(env.DB as D1Database, OTHER, env)
    await restored.importRows('chat_messages', [exported])
    expect((await restored.getMessage(rowId))!.suggestions).toEqual(NAMED.suggestions)

    // The failure the two-sided edit exists to prevent: an import that names every other column but this one
    // binds NULL into a NOT NULL column, and `INSERT OR IGNORE` drops the whole message. A third, empty
    // account isolates it from a primary-key clash — the only reason this row can fail to land is the column.
    const dropped = new AssistantStore(env.DB as D1Database, 'dddddddddddddddddddddddddd', env)
    const stripped: Record<string, unknown> = { ...exported }
    delete stripped.suggestions
    await dropped.importRows('chat_messages', [stripped])
    expect(await dropped.getMessage(rowId)).toBeNull()
  })
})

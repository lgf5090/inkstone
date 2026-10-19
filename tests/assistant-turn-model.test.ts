// @vitest-environment node
/**
 * Which model answers one turn, and whether that turn is allowed to touch anything.
 *
 * Both questions used to have one answer: the reader's own settings row. `POST /api/assistant/chat` read
 * `activeModelId` once per request and nothing else, so a client that wanted a *different* model for one
 * turn had no lever and had to move the setting to get one — which let any other request in that window
 * resolve the wrong model, let a concurrent settings write interleave with the restore, and left a reader
 * who closed the tab on a model they never picked. The request can now name its own model, checked against
 * the rows the caller owns and may use for chat, and refused rather than quietly answered by the default:
 * a turn that used another model than the one asked for looks exactly like one that was right.
 *
 * The second lever is a turn that may not call anything. A model decides for itself to write a note, and on
 * a comparison it would write it a second time after the thread's own answer had already done it — so a turn
 * flagged `noTools` sends no schemas (the same door a model with `supportsTools` turned off goes through),
 * refuses whatever it invents anyway, and files the refusal on the row.
 *
 * The third case is the answer's own record: a turn whose tool found things to cite has to say so on the
 * event that ends the turn, because that event is what the live transcript is built from, and a row that
 * arrives without its citations shows an answer that looks unsearched until the thread is reopened.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import { newId } from '../src/worker/lib/id'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantMessage, AssistantModel, AssistantSettings, ChatStreamEvent } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const FIRST_BASE = 'https://first.example.test'
const SECOND_BASE = 'https://second.example.test'
const SPARE_BASE = 'https://spare.example.test'
/** The engine a first-party search is asked to use, and the only search address these stubs answer. */
const ENGINE = 'https://search.example.test/search'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
let settings: AssistantSettings
/** The reader's standing pick, the model a turn may name instead, and the spare behind the second one. */
let first: AssistantModel
let second: AssistantModel
let spare: AssistantModel
/** The turn is scheduled on the context, so the test has to hold one that accepts the task. */
const turnTasks: Promise<unknown>[] = []
const ctx = { waitUntil: (task: Promise<unknown>) => { turnTasks.push(task) } } as ExecutionContext

async function settleTurns(): Promise<void> {
  await Promise.all(turnTasks.splice(0))
}

function buildApp(userId: string): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  return instance
}

async function chat(body: Record<string, unknown>): Promise<Response> {
  return await app.fetch(new Request('http://localhost/api/assistant/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env, ctx)
}

async function refusal(response: Response): Promise<{ status: number, message: string }> {
  const body = await response.json() as { error?: { message?: string } }
  return { status: response.status, message: body.error?.message ?? '' }
}

function sse(frames: readonly string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const USAGE = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })

/** One step that answers in prose and stops. */
/** The naming pass's own instructions: the one thing that tells its call apart from a turn's. */

function answered(text: string): string[] {
  return [frame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: text } }] }), USAGE]
}

/** One step that asks for a tool, in the shape an OpenAI-compatible server sends it. */
function called(name: string, args: Record<string, unknown>): string[] {
  return [
    frame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }] } }] }),
    frame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
  ]
}

/**
 * A provider that answers from a queue, and records every body it was sent.
 *
 * The assertions worth making here are all about the request — which address it went to, which model id it
 * named, whether a tool list travelled with it — and a reply that merely arrived cannot tell those apart.
 * An address nobody stubbed fails the test rather than answering for it: the bug this file exists for is a
 * turn quietly calling a model the caller did not name, and a permissive stub would hide exactly that.
 */
function stubWire(...answers: Array<{ at: string, frames: string[] } | { status: number }>): {
  bodies: () => Record<string, unknown>[]
  urls: () => string[]
} {
  const seen: { url: string, body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { body?: unknown }) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    // The follow-up pass that runs after the answer is filed is not part of the turn's own traffic. Every
    // case here counts what one question cost — one call, or two with a tool step between them — so that
    // call is answered and left out of the log rather than adding one to every number in this file. It is
    // recognised by the instructions it was sent with, which no turn's request carries.
    if (isNamingRequest(body)) return namingAnswer()
    seen.push({ url, body })
    const answer = seen.length <= answers.length ? answers[seen.length - 1] : answers.at(-1)
    if (!answer) throw new Error(`nothing stubbed for ${url}`)
    if ('status' in answer) return new Response('{"error":{"message":"the provider does not know that model"}}', { status: answer.status })
    if (!url.startsWith(answer.at)) throw new Error(`the turn called ${url}, which it was not asking of (expected ${answer.at})`)
    return sse(answer.frames)
  }))
  return {
    bodies: () => seen.map((entry) => entry.body),
    urls: () => seen.map((entry) => entry.url),
  }
}

/** One accepted turn, read back as the events it carried. */
async function streamed(body: Record<string, unknown>): Promise<ChatStreamEvent[]> {
  const response = await chat(body)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.text()).split('\n\n').filter((part) => part.startsWith('data:'))
    .map((part) => JSON.parse(part.slice(5)) as ChatStreamEvent)
}

const doneOf = (events: ChatStreamEvent[]): AssistantMessage | undefined =>
  events.find((event) => event.type === 'done')?.finalMessage

/** Reads the answer straight back off the row, the way a reopened thread would. */
async function storedAnswer(conversationId: string): Promise<AssistantMessage | undefined> {
  const rows = await store.messages(conversationId, 20)
  return rows.find((row) => row.role === 'assistant')
}

function taskCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS n FROM chat_tasks WHERE user_id = ?').get(USER) as { n: number }).n
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  app = buildApp(USER)
  store = new AssistantStore(env.DB as D1Database, USER, env)

  const firstProvider = await store.createProvider({ label: 'First', protocol: 'openai', baseUrl: FIRST_BASE, apiKey: '' })
  const secondProvider = await store.createProvider({ label: 'Second', protocol: 'openai', baseUrl: SECOND_BASE, apiKey: '' })
  const spareProvider = await store.createProvider({ label: 'Spare', protocol: 'openai', baseUrl: SPARE_BASE, apiKey: '' })
  first = await store.createModel({ providerId: firstProvider.id, model: 'first-model', label: 'First model' })
  second = await store.createModel({ providerId: secondProvider.id, model: 'second-model', label: 'Second model' })
  spare = await store.createModel({ providerId: spareProvider.id, model: 'spare-model', label: 'Spare model' })
  // The spare sits behind the *second* model, so a chain that jumped to the account default instead of
  // following the named model's own spare is caught here rather than believed.
  await store.updateModel(second.id, { fallbackModelId: spare.id })
  settings = await store.saveSettings({ ...(await store.getSettings()), activeModelId: first.id })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  // A turn whose stream the test never finished reading still has to settle before the next database.
  await settleTurns()
})

describe('a turn that names its own model', () => {
  it('answers on the model it named, and charges that model', async () => {
    const wire = stubWire({ at: SECOND_BASE, frames: answered('Spoken by the second model.') })
    const events = await streamed({ message: 'Asked of a different model.', modelId: second.id })

    // One request, to the named model's own provider, naming the named model.
    expect(wire.urls()).toHaveLength(1)
    expect(wire.urls()[0]).toContain(SECOND_BASE)
    expect(wire.bodies()[0]?.model).toBe('second-model')
    // The reader's standing pick was never asked: a turn that called it too would spend the budget twice
    // and say nothing about it.
    expect(wire.urls().some((url) => url.includes(FIRST_BASE))).toBe(false)

    const answer = doneOf(events)
    expect(answer?.content).toBe('Spoken by the second model.')
    expect(answer?.modelLabel).toBe('Second model')

    // The day's counters name the model that answered, by id as well as by label, so the cost screen can
    // attribute a turn a reader never ran on their own pick.
    const day = await store.currentUsageDay()
    const rows = sqlite.prepare('SELECT model_label, model_id FROM chat_usage_daily_model WHERE user_id = ? AND day = ?')
      .all(USER, day) as { model_label: string, model_id: string | null }[]
    expect(rows).toEqual([{ model_label: 'Second model', model_id: second.id }])
  })

  it('answers on the account’s own pick when the turn names none', async () => {
    const wire = stubWire({ at: FIRST_BASE, frames: answered('Spoken as usual.') })
    const events = await streamed({ message: 'An ordinary question.' })
    expect(wire.urls()[0]).toContain(FIRST_BASE)
    expect(wire.bodies()[0]?.model).toBe('first-model')
    expect(doneOf(events)?.modelLabel).toBe('First model')
    // Nothing about the settings row moved: a turn that names no model is the turn it always was.
    expect((await store.getSettings()).activeModelId).toBe(first.id)
  })

  const refusals: readonly (readonly [string, () => Promise<string>])[] = [
    ['an id that is nobody’s', async () => newId()],
    ['another account’s model', async () => {
      const foreign = new AssistantStore(env.DB as D1Database, OTHER, env)
      const provider = await foreign.createProvider({ label: 'Theirs', protocol: 'openai', baseUrl: 'https://theirs.example.test', apiKey: '' })
      return (await foreign.createModel({ providerId: provider.id, model: 'theirs' })).id
    }],
    ['a model the reader turned off', async () => {
      await store.updateModel(second.id, { enabled: false })
      return second.id
    }],
    ['a model that does not chat', async () => {
      await store.updateModel(spare.id, { purpose: 'image_generate' })
      return spare.id
    }],
  ]

  it.each(refusals)('refuses %s instead of answering on the active model', async (_label, pick) => {
    const wire = stubWire({ at: FIRST_BASE, frames: answered('The answer nobody asked for.') })
    const conversation = await store.createConversation('Refused')
    const response = await chat({ conversationId: conversation.id, message: 'Ask the other one.', modelId: await pick() })

    const said = await refusal(response)
    expect(said.status).toBe(400)
    expect(said.message).toContain('not an enabled chat model')
    // The failure this parameter exists to prevent: the account's own model replying to a request that
    // asked for a different one, in a stream no caller can tell apart from the answer it wanted.
    expect(wire.urls(), 'a refused turn still reached the provider').toHaveLength(0)
    expect(await store.messages(conversation.id), 'a refused turn still filed a turn').toHaveLength(0)
  })
})

describe('the chain behind a named model', () => {
  it('fails over to the named model’s own spare, not to the account default', async () => {
    // A 404 is the provider saying it does not know this model: not worth repeating on the same door, and
    // exactly the case the reader's spare exists for.
    const wire = stubWire({ status: 404 }, { at: SPARE_BASE, frames: answered('The spare answered.') })
    const events = await streamed({ message: 'Asked of a model that has gone away.', modelId: second.id })

    expect(wire.urls()).toHaveLength(2)
    expect(wire.urls()[1]).toContain(SPARE_BASE)
    expect(wire.bodies()[1]?.model).toBe('spare-model')
    // The chain belongs to the model that was named. Answering a comparison's second column with the
    // reader's own pick would put the same voice in both of them and still call itself a comparison.
    expect(wire.urls().some((url) => url.includes(FIRST_BASE)), 'the fallback chain fell back to the account default').toBe(false)

    const answer = doneOf(events)
    expect(answer?.content).toBe('The spare answered.')
    expect(answer?.modelLabel).toBe('Spare model')
    expect((await storedAnswer(answer!.conversationId))?.modelLabel).toBe('Spare model')
  })
})

describe('a turn that may not use tools', () => {
  it('sends no schemas, and runs nothing the model invents', async () => {
    const wire = stubWire({ at: FIRST_BASE, frames: [...called('create_task', { title: 'Written twice' }), ...answered('Noted, without writing anything.')] })
    const events = await streamed({ message: 'Answer this without touching anything.', noTools: true })

    // Nothing offered: the request carries no tool list at all, so the model cannot be blamed for reading
    // one it was never given.
    expect(wire.bodies()[0]?.tools, 'a no-tools turn still sent tool schemas').toBeUndefined()
    // Nothing ran: the write the model asked for is the one this flag exists to stop.
    expect(taskCount(), 'a no-tools turn ran a write tool').toBe(0)
    expect(wire.urls(), 'a refused call went on to another step').toHaveLength(1)

    const answer = doneOf(events)
    expect(answer?.content).toBe('Noted, without writing anything.')
    expect(answer?.status).toBe('complete')
    // The refusal is on the row, so a reader who opens this answer can see why it cites nothing rather than
    // reading a silent answer as one that simply had nothing to say.
    expect((await storedAnswer(answer!.conversationId))?.tools.map((tool) => tool.name)).toEqual(['create_task'])
    expect(answer?.tools[0]?.status).toBe('error')
    expect(answer?.tools[0]?.error).toContain('without tools')
  })

  it('offers the tool, and runs it, when the turn did not ask otherwise', async () => {
    // The same fixture with the flag off: without this, the case above could be passing because the tool was
    // never reachable in the first place.
    const wire = stubWire(
      { at: FIRST_BASE, frames: called('create_task', { title: 'Written once' }) },
      { at: FIRST_BASE, frames: answered('Written.') },
    )
    const events = await streamed({ message: 'Make me a task.' })

    expect(JSON.stringify(wire.bodies()[0]?.tools ?? [])).toContain('create_task')
    expect(wire.urls()).toHaveLength(2)
    expect(taskCount()).toBe(1)
    expect(doneOf(events)?.content).toBe('Written.')
  })

  it('does not let a web-search switch through either', async () => {
    await store.saveSettings({ ...settings, webSearchEndpoint: ENGINE })
    const wire = stubWire({ at: FIRST_BASE, frames: answered('Answered from what it already knew.') })
    const events = await streamed({ message: 'Search the web, but not with tools.', webSearch: true, noTools: true })

    // The engine was never asked, no search tool was offered, and the switch that could not be carried out
    // is reported rather than left looking like a search that happened.
    expect(wire.urls().some((url) => url.includes(ENGINE))).toBe(false)
    expect(JSON.stringify(wire.bodies()[0]?.tools ?? '')).not.toContain('web_search')
    expect(events.filter((event) => event.type === 'notice').map((event) => event.notice)).toEqual(['web_search_unavailable'])
  })
})

describe('a model switched off for tools', () => {
  it('holds the switch on its own row, written and read back', async () => {
    // The column is the whole feature: a switch the editor saves and the next read forgets is a switch
    // that does nothing, and `supportsTools` arrived through the same three lists.
    const updated = await store.updateModel(first.id, { noTools: true })
    expect(updated?.noTools).toBe(true)
    expect((await store.getModel(first.id))?.noTools).toBe(true)
    // The models listed for the picker carry it too, or the runner reads a model whose flag it cannot see.
    expect((await store.listModels()).find((model) => model.id === first.id)?.noTools).toBe(true)
    // Turning it back off is a value, not an absent patch: a PATCH that named no other field must not
    // stamp the columns it did not name back to their defaults.
    expect((await store.updateModel(first.id, { noTools: false }))?.noTools).toBe(false)
    expect((await store.getModel(first.id))?.label).toBe('First model')
  })

  it('sends no schemas and refuses what the model invents, with nothing said about the turn', async () => {
    await store.updateModel(first.id, { noTools: true })
    const wire = stubWire({ at: FIRST_BASE, frames: [...called('create_task', { title: 'Written anyway' }), ...answered('I cannot write anything.')] })
    const events = await streamed({ message: 'Make me a task.' })

    expect(wire.bodies()[0]?.tools, 'a model switched off for tools still got the schemas').toBeUndefined()
    expect(taskCount(), 'a model switched off for tools ran a write tool').toBe(0)
    expect(wire.urls(), 'a refused call went on to another step').toHaveLength(1)

    const answer = doneOf(events)
    expect(answer?.content).toBe('I cannot write anything.')
    // Filed as refused rather than dropped, and named for the reason that refused it — the model's own
    // switch, not a turn that never asked for one.
    expect(answer?.tools[0]?.status).toBe('error')
    expect(answer?.tools[0]?.error).toContain('so the call never ran')
    expect(answer?.tools[0]?.error, 'the refusal blamed the turn, which said nothing').toContain('This model is switched off for tools')
    expect((await storedAnswer(answer!.conversationId))?.tools.map((tool) => tool.name)).toEqual(['create_task'])
  })

  it('combines with the turn’s switch rather than replacing it', async () => {
    // Both directions, because an `&&` where the rule is an `||` passes the case above by accident.
    await store.updateModel(first.id, { noTools: true })
    const wire = stubWire({ at: FIRST_BASE, frames: answered('Refused twice over.') })
    await streamed({ message: 'Make me a task.', noTools: true })
    expect(wire.bodies()[0]?.tools).toBeUndefined()

    await store.updateModel(first.id, { noTools: false })
    const offered = stubWire(
      { at: FIRST_BASE, frames: called('create_task', { title: 'Written once' }) },
      { at: FIRST_BASE, frames: answered('Written.') },
    )
    expect(taskCount(), 'the fixture never reached the tool at all').toBe(0)
    const events = await streamed({ message: 'Make me a task.' })
    expect(JSON.stringify(offered.bodies()[0]?.tools ?? [])).toContain('create_task')
    expect(taskCount()).toBe(1)
    expect(doneOf(events)?.content).toBe('Written.')
  })

  it('keeps the vendor search off a model that may not call anything', async () => {
    await store.updateModel(first.id, { noTools: true })
    await store.saveSettings({ ...settings, webSearchEndpoint: ENGINE })
    const wire = stubWire({ at: FIRST_BASE, frames: answered('Answered from what it already knew.') })
    const events = await streamed({ message: 'Search the web.', webSearch: true })

    expect(wire.urls().some((url) => url.includes(ENGINE)), 'a toolless model reached the search engine').toBe(false)
    expect(JSON.stringify(wire.bodies()[0]?.tools ?? '')).not.toContain('web_search')
    expect(events.filter((event) => event.type === 'notice').map((event) => event.notice)).toEqual(['web_search_unavailable'])
  })

  it('follows the switch onto the spare, not just the model first asked', async () => {
    // The chain is resolved per candidate, so a turn named at the second model must go out toolless only
    // when *that* model says so — and the spare behind it decides for itself.
    await store.updateModel(second.id, { noTools: true })
    const wire = stubWire({ at: SECOND_BASE, frames: answered('The named model, without tools.') })
    const events = await streamed({ message: 'Asked of a model that does not call.', modelId: second.id })
    expect(wire.bodies()[0]?.tools).toBeUndefined()
    expect(doneOf(events)?.content).toBe('The named model, without tools.')
  })
})

describe('the answer carries what it read', () => {
  /** One turn, driven straight through the runner, on the account's own settings. */
  async function drive(over: Partial<AssistantSettings>): Promise<ChatStreamEvent[]> {
    const conversation = await store.createConversation('Searched')
    const runToken = await store.claimRun(conversation.id)
    const runner = new AssistantRunner({
      store, env, ftsEnabled: false, origin: 'http://localhost', settings: { ...settings, ...over }, runToken,
    })
    const events: ChatStreamEvent[] = []
    for await (const event of runner.chat({
      conversationId: conversation.id, message: 'What can I self-host?', webSearch: true, signal: new AbortController().signal,
    })) events.push(event)
    await store.releaseRun(conversation.id, runToken!)
    return events
  }

  it('hands the finished row to the event that ends the turn, citations and all', async () => {
    let providerCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: { body?: unknown }) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.startsWith(ENGINE)) {
        return new Response(JSON.stringify({ results: [{ title: 'SearXNG docs', url: 'https://docs.searxng.org/', content: 'Self-hosted metasearch.' }] }), {
          headers: { 'content-type': 'application/json' },
        })
      }
      providerCalls++
      // The model is written as if it read this turn's tool list: it searches when one is offered, and
      // reports afterwards.
      return sse(providerCalls === 1 ? called('web_search', { query: 'self hosted search' }) : answered('Both of them are.'))
    }))
    const events = await drive({ webSearchEndpoint: ENGINE })

    const answer = doneOf(events)
    expect(answer?.status).toBe('complete')
    expect(answer?.content).toBe('Both of them are.')
    // The chips under an answer are read off this row. A live turn built from an event that dropped them
    // showed a searched answer with nothing cited under it until the thread was opened again — which is the
    // one thing a searched answer has to be able to say about itself.
    expect(answer?.sources?.map((source) => source.url)).toEqual(['https://docs.searxng.org/'])
    expect((await storedAnswer(answer!.conversationId))?.sources).toEqual(answer?.sources)
  })
})

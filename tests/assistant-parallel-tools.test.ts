// @vitest-environment node
/**
 * One step's tool calls, run together.
 *
 * A model that asks for three independent lookups in one step used to wait through all three in a row, so
 * the reader paid the sum of three waits for work none of them had to do in order. Starting them together
 * is the easy half. The two things that make it a correctness question are that the transcript the model
 * reads back is still in the order the model asked for — a reordered result list reads as a different set
 * of calls than the one it made — and that a call which fails, or a reader who stops halfway, takes
 * nothing down with it.
 *
 * What proves the overlap is three calls meeting at one barrier, not elapsed time: no assertion here reads
 * a duration. The barrier's fallback timer exists only so that a step run one call at a time finishes and
 * reports itself as such rather than hanging the suite, since such a step can never reach the rendezvous.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantRunner } from '../src/worker/assistant/runner'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import type { AssistantMessage, ChatStreamEvent } from '../src/shared/assistant'
import type { TodoTask } from '../src/shared/todos/model'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isNamingRequest, namingAnswer } from './doubles/naming-pass'

const USER = '0123456789abcdefghjkmnpqrs'

/**
 * Three views of the one read tool, so a single step asks for the same tool three independent ways.
 *
 * `list_tasks` allows three calls a turn and refuses a repeated identical signature, which is the shape
 * needed here: three real calls, each its own call, through a tool the reader's own settings allow.
 */
const VIEWS = ['today', 'upcoming', 'completed']

const TASK: TodoTask = {
  id: 't1', title: '', description: '', status: 'todo', priority: 'medium',
  dueAt: null, projectId: null, createdAt: 1, updatedAt: 1, completedAt: null,
  listId: null, tags: [], dependsOn: [], blocks: [], starred: false, repeat: null, remindAt: null, remindedAt: null,
  plannedFor: null,
  noteId: null, conversationId: null, stepTotal: 0, stepDone: 0,
}

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

/** One call, opened on the index the model gave it. */
const callFrame = (index: number, view: string) => frame({
  choices: [{
    index: 0,
    finish_reason: null,
    delta: { tool_calls: [{ index, id: `call-${index}`, function: { name: 'list_tasks', arguments: JSON.stringify({ view }) } }] },
  }],
})

const finishFrame = (reason: string) => frame({ choices: [{ index: 0, finish_reason: reason, delta: {} }] })
const textFrame = (text: string) => frame({ choices: [{ index: 0, finish_reason: null, delta: { content: text } }] })

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  // A provider with no key at all: `signKey` then answers with an empty string, and nothing has to be
  // decrypted for a turn to reach the stubbed wire.
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  const model = await store.createModel({ providerId: provider.id, model: 'example-model', maxOutputTokens: 256 })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

interface TurnResult {
  conversationId: string
  events: ChatStreamEvent[]
  /** Every request body the model was sent, in order. */
  requests: Record<string, unknown>[]
  /** The views, in the order each call began its work. */
  started: string[]
  /** The views, in the order each call answered. */
  finished: string[]
  final: AssistantMessage | undefined
}

/**
 * A turn whose first step asks for the three lists and whose second step answers.
 *
 * `listTasks` is the one dependency every call of the step goes through, so it is where the test decides
 * the turn's timing instead of the worker's clock. Without it every call answers at once with a row only
 * that view could have produced, which is what makes the filed order readable below.
 */
async function runTurn(input: {
  listTasks?: (view: string) => Promise<TodoTask[]>
  /**
   * Told about each event as it reaches the reader.
   *
   * `stop` ends the turn the way closing a tab does, and `began` is how many calls were already in the air
   * at that exact moment — which is the one reading that distinguishes a step run together from a step run
   * in a row, and cannot be recovered after the turn ends.
   */
  onEvent?: (event: ChatStreamEvent, stop: () => void, began: number) => void
  signal?: AbortSignal
  /** Two calls asking for the same view, which is the repeat the executor exists to refuse. */
  duplicate?: boolean
} = {}): Promise<TurnResult> {
  const conversation = await store.createConversation('Parallel')
  expect(await store.claimRun(conversation.id)).not.toBeNull()

  const started: string[] = []
  const finished: string[] = []
  const asked = input.duplicate ? [VIEWS[0]!, VIEWS[0]!] : VIEWS
  let waiting = 0
  let open!: () => void
  const barrier = new Promise<void>((resolve) => { open = resolve })
  vi.spyOn(store, 'listTasks').mockImplementation(async (query = {}) => {
    const view = query.view ?? 'all'
    started.push(view)
    if (!input.duplicate) {
      if (++waiting === asked.length) open()
      await Promise.race([barrier, sleep(30)])
    }
    const tasks = await (input.listTasks?.(view) ?? Promise.resolve([{ ...TASK, title: `hit-${view}` }]))
    finished.push(view)
    return tasks
  })

  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    // The follow-up pass that runs after the answer is filed is not one of this turn's steps.
    if (isNamingRequest(body)) return namingAnswer()
    requests.push(body)
    const frames = requests.length === 1
      ? [...asked.map((view, index) => callFrame(index, view)), finishFrame('tool_calls')]
      : [textFrame('Three lists, all read at once.'), finishFrame('stop')]
    return new Response(sse(frames), { headers: { 'content-type': 'text/event-stream' } })
  }))

  const runner = new AssistantRunner({
    store,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: await store.getSettings(),
  })
  const controller = new AbortController()
  const events: ChatStreamEvent[] = []
  try {
    for await (const event of runner.chat({
      conversationId: conversation.id,
      message: 'And now all three at once?',
      signal: input.signal ?? controller.signal,
    })) {
      events.push(event)
      input.onEvent?.(event, () => controller.abort(), started.length)
    }
  } finally {
    vi.unstubAllGlobals()
  }
  const done = events.find((event) => event.type === 'done') as { finalMessage?: AssistantMessage } | undefined
  return { conversationId: conversation.id, events, requests, started, finished, final: done?.finalMessage }
}

/** The messages a later request carries for the calls of the step before it, in the order it carries them. */
function toolResults(request: Record<string, unknown> | undefined): { id: string, content: string }[] {
  const messages = (request?.messages ?? []) as { role: string, tool_call_id?: string, content?: string }[]
  return messages
    .filter((entry) => entry.role === 'tool')
    .map((entry) => ({ id: entry.tool_call_id ?? '', content: String(entry.content ?? '') }))
}

describe('the calls of one step', () => {
  it('are all in the air before the first of them answers', async () => {
    let releaseLast!: () => void
    const last = new Promise<void>((resolve) => { releaseLast = resolve })
    let answered = 0
    let arrivedByFirstAnswer = 0
    // The call the model asked for first is the one that answers last, so the order the results are filed
    // in cannot be mistaken for the order they happened to finish in.
    const turn = await runTurn({
      listTasks: async (view) => {
        if (view === VIEWS[0]) {
          // Raced rather than awaited: a step run one call at a time would otherwise sit here forever, and
          // the miss below is the point.
          await Promise.race([last, sleep(30)])
        } else if (++answered === VIEWS.length - 1) {
          releaseLast()
        }
        return [{ ...TASK, title: `hit-${view}` }]
      },
      onEvent: (event, _stop, began) => {
        if (arrivedByFirstAnswer === 0 && event.type === 'tool' && event.tool && event.tool.status !== 'running') {
          arrivedByFirstAnswer = began
        }
      },
    })

    // Three calls waiting at one rendezvous before any of them answered is the whole proof of overlap: run
    // one at a time, the first call finishes alone and this reports one.
    expect(arrivedByFirstAnswer).toBe(VIEWS.length)
    // And the fixture kept its promise: the call the model asked for first is the one that answered last,
    // so the order filed below cannot be an accident of the order they happened to finish in.
    expect(turn.started).toEqual(VIEWS)
    expect(turn.finished.at(-1)).toBe(VIEWS[0])
  })

  it('are read back by the next step in the order the model asked for them', async () => {
    const turn = await runTurn({})

    expect(turn.requests).toHaveLength(2)
    const second = turn.requests[1]!
    const assistant = ((second.messages ?? []) as { role: string, tool_calls?: { id: string }[] }[])
      .find((entry) => entry.role === 'assistant' && entry.tool_calls)
    expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(['call-0', 'call-1', 'call-2'])
    const results = toolResults(second)
    expect(results.map((entry) => entry.id)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(results.map((entry) => entry.content)).toEqual([
      expect.stringContaining('hit-today'),
      expect.stringContaining('hit-upcoming'),
      expect.stringContaining('hit-completed'),
    ])
    // The chips the reader watched are the same three calls, in the same order, in the stored row.
    expect(turn.final?.tools.map((tool) => tool.id)).toEqual(['call-0', 'call-1', 'call-2'])
    expect(turn.final?.status).toBe('complete')
    expect(turn.final?.content).toBe('Three lists, all read at once.')
  })

  it('loses nothing when one of them fails', async () => {
    const turn = await runTurn({
      listTasks: async (view) => {
        if (view === VIEWS[1]) throw new Error('the list service is down')
        return [{ ...TASK, title: `hit-${view}` }]
      },
    })

    const results = toolResults(turn.requests[1])
    expect(results).toHaveLength(VIEWS.length)
    // The failing call names itself; the two that answered keep their answers rather than being dropped
    // along with a sibling that went wrong.
    expect(results[0]!.content).toContain('hit-today')
    expect(results[1]!.content).toContain('the list service is down')
    expect(results[2]!.content).toContain('hit-completed')
    expect(results.every((entry) => entry.content.length > 0)).toBe(true)
    expect(turn.final?.tools.map((tool) => tool.status)).toEqual(['success', 'error', 'success'])
    expect(turn.final?.tools[1]?.error).toContain('the list service is down')
    // And the turn is still answered, not failed: one bad lookup is a fact the model is told, not a crash.
    expect(turn.final?.status).toBe('complete')
    expect(turn.events.some((event) => event.type === 'error')).toBe(false)
  })

  it('are not written into a turn the reader has already left', async () => {
    const turn = await runTurn({
      onEvent: (event, stop) => {
        // The first answer the reader sees is also the last one the turn is willing to file.
        if (event.type === 'tool' && event.tool && event.tool.status !== 'running') stop()
      },
    })

    expect(turn.final?.status).toBe('cancelled')
    // The step ended where the reader did: nothing further went out, so no tool answer was written into a
    // turn that was being closed. What was already in the air was waited for rather than left dangling
    // behind a rejection nobody would ever see, which is why the turn ends cleanly instead of loudly.
    expect(turn.requests).toHaveLength(1)
    expect(turn.events.some((event) => event.type === 'error')).toBe(false)
    // The words the reader had already watched arrive are still filed, and this step wrote none of them.
    expect(turn.final?.content).toBe('')
  })
})

/**
 * The duplicate refusal, asked for inside one batched step.
 *
 * `ToolExecutor` records a call's signature synchronously, before its first await, and the pool hands its
 * calls out in order — so the second of two identical asks is refused on exactly the call it was refused on
 * when a step ran them one at a time. That is only true because the check keeps happening before anything
 * is awaited, and this is the case that says so.
 */
describe('a step that asks for the same call twice', () => {
  it('runs the call once and tells the model about the repeat', async () => {
    const turn = await runTurn({ duplicate: true })

    // The second ask never reaches the tool: the refusal happens where the call is taken, before any of
    // its work is started, and batching cannot move that check behind an await.
    expect(turn.started).toEqual([VIEWS[0]])
    const results = toolResults(turn.requests[1])
    expect(results).toHaveLength(2)
    expect(results[0]!.content).toContain('hit-today')
    expect(results[1]!.content).toContain('already made')
    expect(turn.final?.tools.map((tool) => tool.status)).toEqual(['success', 'error'])
    expect(turn.final?.status).toBe('complete')
  })
})

// @vitest-environment node
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
import type { AssistantModel, ChatStreamEvent, ToolActivity } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * A project that names the notes it reads, one by one.
 *
 * A project's knowledge used to be selectable only by folder, which is the wrong grain for the case that
 * started it: a brief that should be answered from three specific pages sitting in a folder that holds
 * three hundred. The ids a caller names are the reader's own or nothing — a project that quietly kept the
 * ones it could not verify would report a knowledge base it does not have, and one that kept a stranger's
 * id would hand that stranger's note to the model the moment this account made a note with the same id.
 */

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'
const BASE = 'https://wire.example.test'
/** ULID-shaped ids, because every id on this path is shape-checked before it is bound into SQL. */
const PINNED = '0123456789abcdefghjkmnp001'
const PRIVATE = '0123456789abcdefghjkmnp002'
const STRANGER = '0123456789abcdefghjkmnp003'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
let model: AssistantModel

function note(id: string, userId: string, title: string, content: string): void {
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, content, excerpt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)`)
    .run(id, userId, title, content, content)
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

/**
 * The execution context, narrowed to the one member these routes reach for.
 *
 * Named rather than inlined so the shape is stated once: nothing these tests defer needs waiting on, and a
 * `never` here would let a route that starts calling `waitUntil` for real pass while doing nothing.
 */
const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/assistant${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx)
}

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
const USAGE = frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } })
const ANSWER = frame({ choices: [{ index: 0, finish_reason: 'stop', delta: { content: 'Read them.' } }] })

/** One step that asks to read a note by id — the shape an OpenAI-compatible server sends it in. */
function reads(id: string): string[] {
  return [
    frame({ choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, id: `call-${id}`, function: { name: 'read_note', arguments: JSON.stringify({ id }) } }] } }] }),
    frame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }),
  ]
}

/**
 * A turn whose model reads the named notes one at a time and then answers.
 *
 * The stub hands back one step per call, in order, so a scope that refused the second read is caught by
 * the tool event rather than by the prose: which is the only way to tell "the note was not offered" from
 * "the model chose not to look".
 */
async function driveTurn(projectNoteIds: string[] | undefined, readIds: string[]): Promise<ChatStreamEvent[]> {
  const conversation = await store.createConversation('Pinned')
  if (projectNoteIds) {
    const project = await store.createProject({ name: `Brief ${newId()}`, noteIds: projectNoteIds })
    expect(await store.setConversationProject(conversation.id, project.id)).toBe(true)
  }
  let step = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] }
    // The schemas are what decide whether the model can ask at all; recording them is what makes the
    // claim "the note reached the context" checkable against the wire instead of believed.
    const frames = step < readIds.length ? reads(readIds[step]!) : [ANSWER, USAGE]
    step++
    void body
    return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })
  }))
  const token = await store.claimRun(conversation.id)
  const runner = new AssistantRunner({
    store, env, ftsEnabled: false, origin: 'http://localhost',
    settings: { ...(await store.getSettings()), activeModelId: model.id },
    runToken: token,
  })
  const events: ChatStreamEvent[] = []
  for await (const event of runner.chat({
    conversationId: conversation.id, message: 'What do these pages say?', signal: new AbortController().signal,
  })) events.push(event)
  await store.releaseRun(conversation.id, token!)
  return events
}

/** The finished tool cards, in the order they ran — a `running` placeholder says nothing about scope. */
const toolEvents = (events: ChatStreamEvent[]): ToolActivity[] => events
  // Narrowed by the frame's own type rather than by a cast: `tool` rides only on a tool frame, and an
  // `undefined` left in the list would let an assertion below pass on a turn that ran nothing at all.
  .flatMap((event) => (event.type === 'tool' && event.tool ? [event.tool] : []))
  .filter((tool) => tool.status && tool.status !== 'running')

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  app = buildApp(USER)
  store = new AssistantStore(env.DB as D1Database, USER, env)
  const provider = await store.createProvider({ label: 'Wire', protocol: 'openai', baseUrl: BASE, apiKey: '' })
  model = await store.createModel({ providerId: provider.id, model: 'wire-model', label: 'Wire model' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
  note(PINNED, USER, 'Pinned page', 'the pinned fact')
  note(PRIVATE, USER, 'Other page', 'a fact nobody asked for')
  note(STRANGER, OTHER, 'Stranger page', 'not this account\'s note')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a project that names its notes one by one', () => {
  it('keeps the named notes on its row, written and read back', async () => {
    const created = await store.createProject({ name: 'Briefing', noteIds: [PINNED] })
    expect(created.noteIds).toEqual([PINNED])
    expect((await store.getProject(created.id))?.noteIds).toEqual([PINNED])
    expect((await store.listProjects()).find((project) => project.id === created.id)?.noteIds).toEqual([PINNED])

    // Clearing is a value, not an absent patch, and the folders written beside it stay where they were.
    await store.updateProject(created.id, { noteScope: [PRIVATE] })
    const cleared = await store.updateProject(created.id, { noteIds: [] })
    expect(cleared?.noteIds).toEqual([])
    expect(cleared?.noteScope).toEqual([PRIVATE])
  })

  it('refuses a note the caller does not own rather than dropping it', async () => {
    const refused = await request('POST', '/projects', { name: 'Borrowed', noteIds: [STRANGER] })
    expect(refused.status, 'a stranger\'s note id went in unchallenged').toBe(400)
    expect((await refused.json() as { error?: { message?: string } }).error?.message).toMatch(/note/i)

    const created = await request('POST', '/projects', { name: 'Mine', noteIds: [PINNED] })
    expect(created.status).toBe(201)
    const project = (await created.json() as { project: { id: string, noteIds: string[] } }).project
    expect(project.noteIds).toEqual([PINNED])

    // The same rule on the way back in: a PATCH naming one foreign id is refused whole, and writes nothing.
    const patched = await request('PATCH', `/projects/${project.id}`, { noteIds: [PINNED, STRANGER] })
    expect(patched.status).toBe(400)
    expect((await store.getProject(project.id))?.noteIds, 'the refused PATCH still moved the row').toEqual([PINNED])
  })

  it('refuses a note id that is not even the right shape', async () => {
    const response = await request('POST', '/projects', { name: 'Rubbish', noteIds: ['not-an-id'] })
    expect(response.status).toBe(400)
  })
})

describe('the notes a project names reach the turn', () => {
  it('lets the note tool read a page the project named', async () => {
    const tools = toolEvents(await driveTurn([PINNED], [PINNED]))
    expect(tools).toHaveLength(1)
    expect(tools[0]?.status, `the pinned note was refused: ${tools[0]?.error ?? 'no error given'}`).toBe('success')
    expect(tools[0]?.result).toContain('the pinned fact')
  })

  it('refuses a page the project did not name, while its pin still stands', async () => {
    // The direction that makes this a permission rather than a preference: a project that named one page
    // and reached the rest of the vault would read as a knowledge base and behave as an open one.
    const tools = toolEvents(await driveTurn([PINNED], [PINNED, PRIVATE]))
    expect(tools.map((tool) => tool.status)).toEqual(['success', 'error'])
    expect(tools[1]?.error).toMatch(/not available/i)
  })

  it('reads every page once the project has named none', async () => {
    // Positive control. Without it the case above could be passing because the tool reaches nothing at all.
    const tools = toolEvents(await driveTurn(undefined, [PINNED, PRIVATE]))
    expect(tools.map((tool) => tool.status)).toEqual(['success', 'success'])
  })
})

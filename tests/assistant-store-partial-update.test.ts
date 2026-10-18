// @vitest-environment node
/**
 * A PATCH that writes a row it did not mention, and a thread that stops at one page.
 *
 * `updateModel` read the whole row, merged the patch into it and wrote all twenty columns back. Two
 * toggles pressed a moment apart — the four on a model list row, the three in the composer, an editor
 * saving its draft, a second tab — each read the row before the other had written it, so whichever
 * landed second restamped the field it never mentioned with whatever it had read at the start. One
 * switch silently went back.
 *
 * The other half is `messages`, which answers with the newest 500 rows. Routes that treat that page as
 * the thread 404 on an older turn and export a conversation whose beginning is missing, in a file that
 * looks complete. The window is right for a transcript on screen and for the context a model is sent;
 * it was wrong underneath a reader acting on one named row.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantModel, AssistantProvider } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
/** The size of one page, which is what `messages` answers with unless it is told otherwise. */
const PAGE = 500

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let provider: AssistantProvider
let model: AssistantModel
let app: Hono<AppBindings>
/** The turn a streamed request handed to `waitUntil`, which the test has to settle before it looks. */
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

async function respond(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await respond(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<number> {
  const response = await respond(method, path, body)
  await response.text()
  return response.status
}

/**
 * A thread long enough to fall off one page, written in one statement.
 *
 * Rows go in through the table rather than `addMessage` because the test only needs the thread to be
 * long; six hundred turns through the store would be six hundred pairs of writes before the first
 * assertion runs.
 */
function seedThread(conversationId: string, turns: number): string[] {
  const at = Date.now()
  const ids: string[] = []
  const rows: string[] = []
  for (let index = 0; index < turns; index++) {
    const id = newId()
    ids.push(id)
    const role = index % 2 === 0 ? 'user' : 'assistant'
    rows.push(`('${id}', '${USER}', '${conversationId}', '${role}', 'Turn ${index}', ${at + index})`)
  }
  sqlite.exec(`INSERT INTO chat_messages (id, user_id, conversation_id, role, content, created_at) VALUES ${rows.join(', ')}`)
  return ids
}

/**
 * How many turns a thread holds, counted straight off the table.
 *
 * So a long-thread assertion says what the route wrote rather than failing on the read added to fix it.
 */
function threadSize(conversationId: string): number {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND conversation_id = ?')
    .get(USER, conversationId) as { n: number | bigint } | undefined
  return Number(row?.n ?? 0)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
  provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

describe('a model PATCH that names one field', () => {
  it('keeps both fields when two store writes overlap', async () => {
    await store.updateModel(model.id, { reasoning: 'low', contextTokens: 1_000 })
    // Neither call has written when both have read: the shape of two toggles pressed a moment apart.
    const first = store.updateModel(model.id, { reasoning: 'high' })
    const second = store.updateModel(model.id, { contextTokens: 1_048_576 })
    await Promise.all([first, second])
    const after = await store.getModel(model.id)
    expect(after?.reasoning).toBe('high')
    expect(after?.contextTokens).toBe(1_048_576)
  })

  it('keeps both fields when two PATCH requests overlap', async () => {
    await store.updateModel(model.id, { reasoning: 'low', contextTokens: 1_000 })
    const responses = await Promise.all([
      respond('PATCH', `/api/assistant/models/${model.id}`, { reasoning: 'high' }),
      respond('PATCH', `/api/assistant/models/${model.id}`, { contextTokens: 1_048_576 }),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const after = await store.getModel(model.id)
    expect(after?.reasoning).toBe('high')
    expect(after?.contextTokens).toBe(1_048_576)
  })

  it('writes null as a value and leaves a field it did not name alone', async () => {
    await store.updateModel(model.id, {
      temperature: 0.25, topP: 0.5, modalities: ['audio'],
      customParams: [{ name: 'reasoning_effort', type: 'number', value: '7' }],
    })
    const renamed = await store.updateModel(model.id, { label: 'Renamed' })
    expect(renamed?.label).toBe('Renamed')
    expect(renamed?.temperature).toBe(0.25)
    expect(renamed?.topP).toBe(0.5)
    expect(renamed?.modalities).toEqual(['audio'])
    expect(renamed?.customParams).toHaveLength(1)
    // Null is the reader emptying the box; it has to reach the row rather than be read as "no change".
    const cleared = await store.updateModel(model.id, { temperature: null, topP: null, fallbackModelId: null })
    expect(cleared?.temperature).toBeNull()
    expect(cleared?.topP).toBeNull()
    expect(cleared?.label).toBe('Renamed')
    expect(cleared?.modalities).toEqual(['audio'])
    expect((await store.getModel(model.id))?.temperature).toBeNull()
    // A patch that names nothing writes nothing, and still answers with the row as it stands.
    const untouched = await store.updateModel(model.id, { label: 'Renamed again' })
    expect(untouched?.label).toBe('Renamed again')
    expect(untouched?.topP).toBeNull()
    expect(await store.updateModel('nosuchmodel', {})).toBeNull()
  })

  it('still refuses a model that is not this account’s', async () => {
    expect(await status('PATCH', `/api/assistant/models/${newId()}`, { label: 'Nobody' })).toBe(404)
  })
})

describe('a provider or project PATCH that names one field', () => {
  it('keeps both fields when two provider writes overlap', async () => {
    await store.updateProvider(provider.id, { baseUrl: 'https://first.example.com' })
    const first = store.updateProvider(provider.id, { label: 'Renamed' })
    const second = store.updateProvider(provider.id, { baseUrl: 'https://second.example.com' })
    await Promise.all([first, second])
    const after = await store.getProvider(provider.id)
    expect(after?.label).toBe('Renamed')
    expect(after?.baseUrl).toBe('https://second.example.com')
    // An edit of the name writes the name: a patch that says nothing about the key leaves the stored
    // ciphertext and its hint where they are.
    const oneField = await store.updateProvider(provider.id, { label: 'Only the label' })
    expect(oneField?.label).toBe('Only the label')
    expect(oneField?.baseUrl).toBe('https://second.example.com')
    expect(oneField?.hasKey).toBe(false)
  })

  it('keeps both fields when two project writes overlap', async () => {
    const project = await store.createProject({ name: 'Alpha', instructions: 'Stand', modelId: model.id })
    const first = store.updateProject(project.id, { instructions: 'Rewritten' })
    const second = store.updateProject(project.id, { name: 'Beta' })
    await Promise.all([first, second])
    const after = await store.getProject(project.id)
    expect(after?.name).toBe('Beta')
    expect(after?.instructions).toBe('Rewritten')
    expect(after?.modelId).toBe(model.id)
    // Null is the project letting go of the model, and an edit of the name keeps it.
    const unlinked = await store.updateProject(project.id, { modelId: null })
    expect(unlinked?.modelId).toBeNull()
    expect(unlinked?.name).toBe('Beta')
    const named = await store.updateProject(project.id, { name: 'Gamma' })
    expect(named?.name).toBe('Gamma')
    expect(named?.modelId).toBeNull()
  })
})

describe('a thread longer than one page', () => {
  it('exports every turn and still answers a page when asked for one', async () => {
    const conversation = await store.createConversation('Long thread')
    const ids = seedThread(conversation.id, PAGE + 120)
    // Deliberately bounded: opening a conversation costs its newest page, and the context window the
    // model is sent asks the same way.
    expect(await store.messages(conversation.id)).toHaveLength(PAGE)
    const payload = await call<{ messages: { id: string, content: string }[] }>('GET', `/api/assistant/conversations/${conversation.id}/export`)
    expect(payload.messages).toHaveLength(ids.length)
    expect(payload.messages[0]?.id).toBe(ids[0])
    expect(payload.messages[0]?.content).toBe('Turn 0')
    expect(payload.messages.at(-1)?.content).toBe(`Turn ${ids.length - 1}`)
    expect(await store.allMessages(conversation.id)).toHaveLength(ids.length)
  })

  it('edits a question that is above the newest page', async () => {
    const conversation = await store.createConversation('Deep question')
    const ids = seedThread(conversation.id, PAGE + 60)
    const response = await respond('PATCH', `/api/assistant/conversations/${conversation.id}/messages/${ids[0]}`, { content: 'Rewritten' })
    expect(response.status, await response.text()).toBe(200)
    expect((await store.getMessage(ids[0]!))?.content).toBe('Rewritten')
    // Every turn drawn from the old wording went with it, all the way to the newest row.
    expect(threadSize(conversation.id)).toBe(1)
  })

  it('deletes a pair that is above the newest page', async () => {
    const conversation = await store.createConversation('Deep pair')
    const ids = seedThread(conversation.id, PAGE + 60)
    const response = await respond('DELETE', `/api/assistant/conversations/${conversation.id}/messages/${ids[2]}`)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const body = JSON.parse(text) as { removed: string[] }
    expect(body.removed).toEqual([ids[2], ids[3]])
    expect(await store.getMessage(ids[3]!)).toBeNull()
    expect(threadSize(conversation.id)).toBe(ids.length - 2)
  })

  it('takes a selection of old turns out by id', async () => {
    const conversation = await store.createConversation('Deep selection')
    const ids = seedThread(conversation.id, PAGE + 60)
    const removed = await call<{ removed: string[] }>('POST', `/api/assistant/conversations/${conversation.id}/messages/delete`, { ids: [ids[0], ids[1]] })
    expect(removed.removed).toEqual([ids[0], ids[1]])
    expect(threadSize(conversation.id)).toBe(ids.length - 2)
  })

  it('copies the whole thread into a branch', async () => {
    const conversation = await store.createConversation('Deep fork')
    const ids = seedThread(conversation.id, PAGE + 20)
    const fork = await call<{ conversation: { id: string } }>('POST', `/api/assistant/conversations/${conversation.id}/fork`, {
      messageId: ids[ids.length - 1],
      title: 'Branch',
    })
    expect(threadSize(fork.conversation.id)).toBe(ids.length)
  })

  it('lets an answer above the newest page be asked again', async () => {
    const conversation = await store.createConversation('Deep retry')
    const ids = seedThread(conversation.id, PAGE + 60)
    // The turn's own guard read the thread as one page, so retrying an answer from before that page was
    // refused with a 404 before a byte of the stream went out. What the guard needs — the answer and the
    // question directly above it — is now read by position.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })))
    const response = await respond('POST', '/api/assistant/chat', { conversationId: conversation.id, retry: true, messageId: ids[3] })
    const text = await response.text()
    await settleTurns()
    vi.unstubAllGlobals()
    expect(response.status, text.slice(0, 300)).toBe(200)
    // The runner keeps its own bounded read of the thread (runner.ts, the retry branch), so the answer
    // itself is still one page short of reachable; that file belongs to another change in this wave.
  })
})

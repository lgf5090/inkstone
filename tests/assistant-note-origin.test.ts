// @vitest-environment node
/**
 * The note a conversation was started from, seen from both ends.
 *
 * `note_id` is the thread's own label: set once at creation, read back by the notebook's backlink panel,
 * and shown by the chat's origin chip. Two things were missing on top of the filter the list already
 * answers with. Nothing could take a wrong label off — `setConversationNote` deliberately keeps the first
 * answer, which is right against a later turn and wrong for a reader who says "that was never about this
 * note"; a mislabelled thread would go on appearing under the page it was mislabelled with. And an id of
 * the wrong shape was dropped silently, so a PATCH that named a note and named nothing answered "done"
 * having changed nothing.
 *
 * The filtered read is asserted here too because the panel now depends on it: a foreign-shaped id has to
 * answer "nothing", never "everything".
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantConversation, AssistantModel, AssistantProvider } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const NOTE = '01hzzzzzzzzzzzzzzzzzzzzz11'
const OTHER_NOTE = '01hzzzzzzzzzzzzzzzzzzzzz22'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let model: AssistantModel
let app: Hono<AppBindings>
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext

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

/** A thread started from one note, written through the store so the row carries the label. */
async function seeded(noteId: string | null, title = 'About the note'): Promise<AssistantConversation> {
  return await store.createConversation(title, null, false, null, noteId)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  model = await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
  await store.saveSettings({ ...(await store.getSettings()), activeModelId: model.id })
})

describe('taking a conversation off its note', () => {
  it('clears the origin when the reader asks for none', async () => {
    const conversation = await seeded(NOTE)
    const payload = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: null })
    expect(payload.conversation.noteId).toBeNull()
    expect((await store.getConversation(conversation.id))?.noteId).toBeNull()
  })

  it('clears only the origin, and leaves the rest of the row as it was', async () => {
    const conversation = await seeded(NOTE, 'Quarterly review')
    await store.setConversationPinned(conversation.id, true)
    const payload = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: null })
    expect(payload.conversation.title).toBe('Quarterly review')
    expect(payload.conversation.pinned).toBe(true)
    expect(payload.conversation.noteId).toBeNull()
  })

  it('drops the thread out of the note’s own list once it is unlinked', async () => {
    const conversation = await seeded(NOTE)
    const listed = async (): Promise<string[]> =>
      (await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?noteId=${NOTE}`)).conversations.map((entry) => entry.id)
    expect(await listed()).toEqual([conversation.id])
    await respond('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: null })
    expect(await listed()).toEqual([])
  })

  it('refuses an id of the wrong shape, and clears nothing on the way', async () => {
    const conversation = await seeded(NOTE)
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: 'not-an-id' })).toBe(400)
    expect((await store.getConversation(conversation.id))?.noteId).toBe(NOTE)
    // The empty string is the same mistake rather than a different one: it names no note either.
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: '' })).toBe(400)
    expect((await store.getConversation(conversation.id))?.noteId).toBe(NOTE)
  })

  it('refuses a well-shaped id that is not a note this account can read', async () => {
    const conversation = await seeded(NOTE)
    const foreign = newId()
    expect(await status('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: foreign })).toBe(400)
    expect((await store.getConversation(conversation.id))?.noteId).toBe(NOTE)
  })

  it('still refuses to move a labelled thread onto a second note', async () => {
    const conversation = await seeded(NOTE)
    sqlite.exec(`INSERT INTO notes (id, user_id, title, content, rev, created_at, updated_at) VALUES ('${OTHER_NOTE}', '${USER}', 'Other', '', 1, 1, 1)`)
    const payload = await call<{ conversation: AssistantConversation }>('PATCH', `/api/assistant/conversations/${conversation.id}`, { noteId: OTHER_NOTE })
    // The write-once rule is what keeps the chip honest; clearing is the reader's own way of overruling it.
    expect(payload.conversation.noteId).toBe(NOTE)
  })
})

describe('the conversations about one note', () => {
  it('answers with that note’s threads and nothing else', async () => {
    const first = await seeded(NOTE, 'Older thread')
    const second = await seeded(NOTE, 'Newer thread')
    await seeded(OTHER_NOTE, 'About something else')
    await seeded(null, 'Started from nowhere')
    // The two rows were created inside one millisecond, so the order the list claims has to be written
    // rather than assumed: `updated_at` is what the panel sorts on.
    sqlite.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(1_000, first.id)
    sqlite.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(2_000, second.id)
    const listed = await call<{ conversations: AssistantConversation[] }>('GET', `/api/assistant/conversations?noteId=${NOTE}`)
    expect(listed.conversations.map((entry) => entry.id)).toEqual([second.id, first.id])
    expect(listed.conversations.every((entry) => entry.noteId === NOTE)).toBe(true)
  })

  it('answers nothing for an id of the wrong shape rather than the whole library', async () => {
    await seeded(NOTE)
    const listed = await call<{ conversations: AssistantConversation[] }>('GET', '/api/assistant/conversations?noteId=not-an-id')
    expect(listed.conversations).toEqual([])
  })
})

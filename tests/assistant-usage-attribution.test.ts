// @vitest-environment node
/**
 * Cost follows the model, not the word it answers to; a thread can be found by the note it started from;
 * and a downvote can say what was wrong.
 *
 * Three server fixes that share a shape: each stores or reads a fact the surface used to infer from a
 * label, an absent filter, or a single verdict letter. The tests below pin the consequence, not the SQL —
 * a renamed model keeps its price, a priced-with-no-currency model is not folded into dollars, a note's
 * threads exclude another account's, and a reason survives to the transcript.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantModel, AssistantModelUsage, AssistantStats } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqr0'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let app: Hono<AppBindings>
const ctx = { waitUntil: (task: Promise<unknown>) => { void task } } as ExecutionContext

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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

async function status(method: string, path: string, body?: unknown): Promise<{ code: number, body: unknown }> {
  const response = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx)
  const text = await response.text()
  return { code: response.status, body: text ? JSON.parse(text) : null }
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  app = buildApp(USER)
  const provider = await store.createProvider({ label: 'Example', protocol: 'openai', baseUrl: 'https://api.example.com', apiKey: '' })
  await store.createModel({ providerId: provider.id, model: 'example-model', label: 'Example one' })
})

describe('cost attributed by model id', () => {
  /** Price the reader's one model, then charge it a day's tokens under its label. */
  async function priceAndCharge(patch: { inputPrice: number, outputPrice: number, priceCurrency?: string }): Promise<void> {
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const target = models.models[0]!
    await store.updateModel(target.id, patch)
    await store.incrementUsage({ requests: 1, inputTokens: 20, outputTokens: 6 }, undefined, 'Example one')
    // The id was resolved from the label at write time and filed on the usage row.
    const usageRow = sqlite.prepare(`SELECT model_id FROM chat_usage_daily_model WHERE user_id = ? AND model_label = ?`)
      .get(USER, 'Example one') as { model_id: string | null }
    expect(usageRow.model_id).toBe(target.id)
  }

  it('keeps a renamed model\'s history priced through its id', async () => {
    await priceAndCharge({ inputPrice: 1, outputPrice: 2, priceCurrency: 'USD' })
    const models = await call<{ models: AssistantModel[] }>('GET', '/api/assistant/models')
    const renamed = await store.updateModel(models.models[0]!.id, { label: 'Renamed away' })
    // The label the usage row was filed under is gone from the model, but the row keeps the id.
    expect(renamed?.label).toBe('Renamed away')

    const stats = await call<AssistantStats>('GET', '/api/assistant/stats?range=all')
    const row = stats.models.find((entry: AssistantModelUsage) => entry.label === 'Example one')
    expect(row, 'the history still shows under the old label').toBeTruthy()
    // Resolved through model_id: a label-only match would find nothing and report it unpriced.
    expect(row!.cost).toBeCloseTo((1 * 20 + 2 * 6) / 1_000_000, 12)
    expect(row!.currency).toBe('USD')
    expect(stats.unpricedModels).toBe(0)
    expect(stats.spend).toEqual([{ currency: 'USD', amount: expect.closeTo((1 * 20 + 2 * 6) / 1_000_000, 12) }])
  })

  it('does not fold a priced-but-currency-less model into a USD total', async () => {
    // Priced, but the reader never chose a currency — so there is no unit the number could be stated in.
    await priceAndCharge({ inputPrice: 1, outputPrice: 2 })
    const stats = await call<AssistantStats>('GET', '/api/assistant/stats?range=all')
    const row = stats.models.find((entry: AssistantModelUsage) => entry.label === 'Example one')
    expect(row!.cost).toBeNull()
    expect(row!.currency).toBe('')
    expect(stats.unpricedModels).toBe(1)
    // The fabrication this removes: a total that was never in dollars.
    expect(stats.spend).toEqual([])
    expect(stats.spend.some((entry) => entry.currency === 'USD')).toBe(false)
  })

  it('leaves an ambiguous or vanished label with no id rather than a guess', () => {
    sqlite.exec(`INSERT INTO chat_models (id, user_id, provider_id, model, label) VALUES
      ('twin-a', '${USER}', 'p', 'x', 'Twin'),
      ('twin-b', '${USER}', 'p', 'x', 'Twin'),
      ('solo', '${USER}', 'p', 'x', 'Solo')`)
    sqlite.exec(`INSERT INTO chat_usage_daily_model (user_id, day, model_label) VALUES
      ('${USER}', '2020-01-01', 'Twin'),
      ('${USER}', '2020-01-01', 'Solo'),
      ('${USER}', '2020-01-01', 'Gone')`)

    // The exact statement the shipped migration runs (its ALTER already landed on this fresh schema).
    const backfill = SCHEMA_MIGRATIONS.find((migration) => migration.version === 94)!.statements[1]!
    sqlite.exec(backfill)

    const rows = sqlite.prepare(`SELECT model_label, model_id FROM chat_usage_daily_model ORDER BY model_label`)
      .all() as Array<{ model_label: string, model_id: string | null }>
    // Only the unambiguous label is attributed; the twin and the deleted-away one stay NULL.
    expect(rows.find((entry) => entry.model_label === 'Solo')?.model_id).toBe('solo')
    expect(rows.find((entry) => entry.model_label === 'Twin')?.model_id).toBeNull()
    expect(rows.find((entry) => entry.model_label === 'Gone')?.model_id).toBeNull()
  })
})

describe('conversations about a note', () => {
  /** A thread of this account started from `noteId`. */
  async function ownThread(noteId: string): Promise<string> {
    const conversation = await store.createConversation('About a note')
    sqlite.exec(`UPDATE chat_conversations SET note_id = '${noteId}' WHERE user_id = '${USER}' AND id = '${conversation.id}'`)
    return conversation.id
  }

  it('answers only that note\'s own threads, and none from another account', async () => {
    const shared = newId()
    const different = newId()
    const mine = await ownThread(shared)
    const otherNote = await ownThread(different)
    // The same note id, but a thread belonging to a different account: it must never surface here.
    sqlite.exec(`INSERT INTO chat_conversations (id, user_id, created_at, updated_at, note_id)
      VALUES ('foreign-thread', '${OTHER}', 1, 1, '${shared}')`)

    const only = await call<{ conversations: Array<{ id: string }> }>(`GET`, `/api/assistant/conversations?noteId=${shared}`)
    const ids = only.conversations.map((entry) => entry.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(otherNote)
    expect(ids).not.toContain('foreign-thread')

    const none = await call<{ conversations: unknown[] }>('GET', `/api/assistant/conversations?noteId=${newId()}`)
    expect(none.conversations).toEqual([])
  })
})

describe('a downvote can say what was wrong', () => {
  async function answer(): Promise<{ conversationId: string, messageId: string }> {
    const conversation = await store.createConversation('Feedback')
    const message = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'An answer' })
    return { conversationId: conversation.id, messageId: message.id }
  }

  function path(entry: { conversationId: string, messageId: string }): string {
    return `/api/assistant/conversations/${entry.conversationId}/messages/${entry.messageId}/feedback`
  }

  it('stores and returns a reason with a downvote', async () => {
    const entry = await answer()
    const response = await call<{ message: { feedback?: string, feedbackReason?: string } }>('PATCH', path(entry), { feedback: 'down', reason: 'It hallucinated a citation' })
    expect(response.message.feedback).toBe('down')
    expect(response.message.feedbackReason).toBe('It hallucinated a citation')
    // The reason rides in the same column the verdict already travels through.
    const raw = sqlite.prepare(`SELECT feedback FROM chat_messages WHERE id = ? AND user_id = ?`).get(entry.messageId, USER) as { feedback: string }
    expect(raw.feedback).toContain('hallucinated')
  })

  it('refuses a reason on an upvote and clears both on null', async () => {
    const entry = await answer()
    const up = await status('PATCH', path(entry), { feedback: 'up', reason: 'nonsense' })
    expect(up.code).toBe(400)
    // An upvote on its own carries no reason.
    const plain = await call<{ message: { feedback?: string, feedbackReason?: string } }>('PATCH', path(entry), { feedback: 'up' })
    expect(plain.message.feedback).toBe('up')
    expect(plain.message.feedbackReason).toBeUndefined()
    // `null` takes the whole verdict back, reason and all.
    const cleared = await call<{ message: { feedback?: string, feedbackReason?: string } }>('PATCH', path(entry), { feedback: null })
    expect(cleared.message.feedback).toBeUndefined()
    expect(cleared.message.feedbackReason).toBeUndefined()
  })

  it('bounds the reason and strips control characters', async () => {
    const entry = await answer()
    const messy = `1\u00002${'x'.repeat(600)}`
    const response = await call<{ message: { feedbackReason?: string } }>('PATCH', path(entry), { feedback: 'down', reason: messy })
    expect(response.message.feedbackReason).not.toContain('\u0000')
    expect(response.message.feedbackReason!.length).toBeLessThanOrEqual(500)
  })
})

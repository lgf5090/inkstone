// @vitest-environment node
/**
 * Keeping one answer: the column, the two routes over a real D1, and the round trip.
 *
 * A conversation already has `starred`, `pinned` and `archived` on its own row. What a reader does to *one
 * answer* — the paragraph that finally settled the question, out of forty turns around it — had nowhere to
 * go, so the mark lived only in the thread they were reading when they made it and on the device that made
 * it. These tests run the routes over a real SQLite behind the D1 double, because the thing at risk here is
 * not a pure function: it is whether one statement lands, whether the answer reports what landed rather than
 * what was asked for, and whether the row still carries it after a backup goes out and comes back.
 *
 * The backup case is the one that has bitten this repository twice. `EXPORT_COLUMNS` is the allowlist the
 * restore builds its `INSERT` from, and `backup.ts` names every column of the row it writes; a column that
 * misses either does not fail loudly here because `saved_at` is nullable — the message lands, and only the
 * keep is gone. So the assertion reads the shelf back through the route rather than trusting the file.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_MIGRATIONS, SCHEMA_STATEMENTS, initializeDatabase } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import type { AssistantConversation, AssistantMessage, SavedMessage } from '../src/shared/assistant'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const OTHER = '0123456789abcdefghjkmnpqrt'

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>
let store: AssistantStore

/** Point the routes and the store at one account of the same database. */
function account(userId: string): void {
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB, userId, env)
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  instance.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('database', { ftsEnabled: false })
    await next()
  })
  instance.route('/api/assistant', assistantRoutes)
  app = instance
}

async function respond(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await respond(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

/** A thread with one stored answer, ready to be kept. */
async function thread(title = 'Kept answers', content = 'The answer that settled it.'): Promise<{
  conversation: AssistantConversation
  message: AssistantMessage
}> {
  const conversation = await store.createConversation(title)
  const message = await store.addMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content,
  })
  return { conversation, message }
}

function savedAtOf(messageId: string, userId = USER): number | null {
  const row = sqlite.prepare('SELECT saved_at FROM chat_messages WHERE id = ?1 AND user_id = ?2')
    .get(messageId, userId) as { saved_at: number | null } | undefined
  return row?.saved_at ?? null
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  account(USER)
})

describe('keeping one answer', () => {
  it('lands the mark, and says what the row holds rather than what was asked', async () => {
    const { conversation, message } = await thread()
    const kept = await call<{ saved: boolean, savedAt: number | null }>(
      'POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`,
    )
    expect(kept.saved).toBe(true)
    expect(typeof kept.savedAt).toBe('number')
    // The answer and the row agree: the state returned is the one the write left behind.
    expect(savedAtOf(message.id)).toBe(kept.savedAt)

    const back = await call<{ messages: AssistantMessage[] }>('GET', `/api/assistant/conversations/${conversation.id}`)
    expect(back.messages[0]?.savedAt).toBe(kept.savedAt)

    const taken = await call<{ saved: boolean, savedAt: number | null }>(
      'POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`,
    )
    expect(taken.saved).toBe(false)
    expect(taken.savedAt).toBeNull()
    expect(savedAtOf(message.id)).toBeNull()
  })

  it('refuses a turn of another account, and one that is not the thread it names', async () => {
    const { conversation, message } = await thread()
    const foreign = await call<{ conversation: AssistantConversation }>('POST', '/api/assistant/conversations', { title: 'Elsewhere' })
    account(OTHER)
    expect((await respond('POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`)).status).toBe(404)
    account(USER)
    expect(savedAtOf(message.id)).toBeNull()
    // Both ids are this account's but the pair is a lie: the message does not live in that thread.
    expect((await respond('POST',
      `/api/assistant/conversations/${foreign.conversation.id}/messages/${message.id}/saved`)).status).toBe(404)
    expect(savedAtOf(message.id)).toBeNull()
    // An id of the wrong shape is not a row anyone kept, and is not looked up either.
    expect((await respond('POST', `/api/assistant/conversations/${conversation.id}/messages/not-an-id/saved`)).status).toBe(404)
  })

  it('lists the shelf newest kept first, with the thread each answer belongs to', async () => {
    const first = await thread('First thread', 'The one kept early.')
    const second = await thread('Second thread', 'The one kept last.')
    await store.toggleMessageSaved(first.message.id, 1_700_000_000_000)
    await store.toggleMessageSaved(second.message.id, 1_700_000_000_500)

    const shelf = await call<{ items: SavedMessage[], nextCursor: string | null }>('GET', '/api/assistant/saved-messages')
    expect(shelf.items.map((entry) => entry.id)).toEqual([second.message.id, first.message.id])
    // The row says what it belongs to: a shelf of message ids the reader cannot open is a list of nothing.
    expect(shelf.items[0]).toMatchObject({
      conversationId: second.conversation.id,
      conversationTitle: 'Second thread',
      role: 'assistant',
      savedAt: 1_700_000_000_500,
    })
    expect(shelf.items[0]?.excerpt).toBe('The one kept last.')
    expect(shelf.nextCursor).toBeNull()
  })

  it('pages the shelf by cursor and walks it whole', async () => {
    for (let index = 0; index < 4; index++) {
      const { message } = await thread(`Thread ${index}`, `Answer ${index}`)
      await store.toggleMessageSaved(message.id, 1_700_000_000_000 + index)
    }
    const seen: number[] = []
    let cursor: string | null = null
    for (let page = 0; page < 6; page++) {
      const result: { items: SavedMessage[], nextCursor: string | null } = await call(
        'GET', `/api/assistant/saved-messages?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      expect(result.items).toHaveLength(1)
      seen.push(...result.items.map((entry) => entry.savedAt))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual([1_700_000_000_003, 1_700_000_000_002, 1_700_000_000_001, 1_700_000_000_000])
    expect(cursor).toBeNull()
  })

  it('refuses a cursor nobody issued instead of restarting the shelf', async () => {
    const { message } = await thread()
    await store.toggleMessageSaved(message.id)
    expect((await respond('GET', '/api/assistant/saved-messages?cursor=bm90LWEtY3Vyc29y')).status).toBe(400)
    // A page size out of range is clamped rather than refused: the caller asked for too much, not for
    // something this route cannot answer.
    const big = await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages?limit=100000')
    expect(big.items).toHaveLength(1)
  })

  it('keeps another account off the shelf', async () => {
    const { conversation, message } = await thread('Mine', 'My own answer.')
    await call('POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`)
    account(OTHER)
    const theirs = await thread('Theirs', 'Their answer.')
    await call('POST', `/api/assistant/conversations/${theirs.conversation.id}/messages/${theirs.message.id}/saved`)
    const shelf = await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages')
    expect(shelf.items.map((entry) => entry.id)).toEqual([theirs.message.id])
    account(USER)
    expect((await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages'))
      .items.map((entry) => entry.id)).toEqual([message.id])
  })

  it('leaves a thread the reader asked not to keep off it', async () => {
    const conversation = await store.createConversation('Temporary', null, true)
    const message = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Gone soon.' })
    await store.toggleMessageSaved(message.id)
    expect(savedAtOf(message.id)).not.toBeNull()
    const shelf = await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages')
    expect(shelf.items).toEqual([])
  })
})

describe('a keep that survives the backup', () => {
  it('carries the mark out and back in, where the row still shows it', async () => {
    const { conversation, message } = await thread('Worth returning to', 'The kept paragraph.')
    const at = await call<{ savedAt: number }>(
      'POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`,
    )
    const exported = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    const exportedMessages = (exported.data as { messages: Record<string, unknown>[] }).messages
    expect(exportedMessages.find((entry) => entry.id === message.id)?.saved_at).toBe(at.savedAt)

    account(OTHER)
    await call('POST', '/api/assistant/import', exported)
    // Read back through the shelf: the list route is where the column is used, and a restore that wrote
    // NULL into it lands the message and loses the keep without a word.
    const shelf = await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages')
    expect(shelf.items.map((entry) => entry.id)).toEqual([message.id])
    expect(shelf.items[0]?.savedAt).toBe(at.savedAt)
    expect(shelf.items[0]?.conversationTitle).toBe('Worth returning to')
    expect(savedAtOf(message.id, OTHER)).toBe(at.savedAt)
  })
})

/**
 * The shape a database built before version 102 has, reached by taking the column back off a booted one.
 *
 * The boot is what has to heal it — `initializeDatabase` runs the ledger and then repairs the columns the
 * ledger claims already arrived — so this goes through the real thing rather than an assertion about the
 * migration list's text.
 */
describe('a database that predates the keep', () => {
  async function reboot(): Promise<void> {
    sqlite.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    await initializeDatabase(testBindings(makeD1(sqlite)))
  }

  it('gains the column and the index, and reads every earlier turn as unkept', async () => {
    const conversation = await store.createConversation('Old thread')
    const message = await store.addMessage({ conversationId: conversation.id, role: 'assistant', content: 'Written before keeps existed.' })
    sqlite.exec('DROP INDEX IF EXISTS idx_chat_messages_saved')
    sqlite.exec('ALTER TABLE chat_messages DROP COLUMN saved_at')
    sqlite.exec(`DELETE FROM schema_migrations WHERE version IN (102, 103)`)

    await reboot()

    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('chat_messages')`).all()
      .map((row) => (row as { name: string }).name)
    expect(columns).toContain('saved_at')
    const indexes = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all()
      .map((row) => (row as { name: string }).name)
    expect(indexes).toContain('idx_chat_messages_saved')
    // Nothing was invented for the rows that were already there: every turn nobody kept still reads as one.
    expect(savedAtOf(message.id)).toBeNull()
    const shelf = await call<{ items: SavedMessage[] }>('GET', '/api/assistant/saved-messages')
    expect(shelf.items).toEqual([])
    // And the mark can be made on a thread that arrived from the older shape.
    await call('POST', `/api/assistant/conversations/${conversation.id}/messages/${message.id}/saved`)
    expect(savedAtOf(message.id)).not.toBeNull()
  })

  it('spends two version numbers, one column in the first and only an index in the second', () => {
    // The ledger's own rule, checked rather than assumed: a version adds one column, and an index is its
    // own number. Reusing a spent number is how two branches cancel each other's migration out — see the
    // note on version 95 — and a version that adds two columns cannot be replayed by the repair.
    const added = SCHEMA_MIGRATIONS.flatMap((migration) => migration.statements)
      .filter((statement) => /ALTER TABLE chat_messages ADD COLUMN saved_at/.test(statement))
    expect(added).toHaveLength(1)
    const columnVersion = SCHEMA_MIGRATIONS.find((migration) => migration.statements.some(
      (statement) => statement.includes('ADD COLUMN saved_at'),
    ))
    expect(columnVersion?.version).toBe(102)
    expect(columnVersion?.statements).toHaveLength(1)
    expect(columnVersion?.skipIfColumnExists).toEqual({ table: 'chat_messages', column: 'saved_at' })
    const indexVersion = SCHEMA_MIGRATIONS.find((migration) => migration.statements.some(
      (statement) => statement.includes('idx_chat_messages_saved'),
    ))
    expect(indexVersion?.version).toBe(103)
    expect(indexVersion?.statements).toHaveLength(1)
    const versions = SCHEMA_MIGRATIONS.map((migration) => migration.version)
    expect(new Set(versions).size, 'a version number is spent twice').toBe(versions.length)
  })
})

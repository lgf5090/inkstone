// @vitest-environment node
/**
 * A backup that cannot be restored, a restore that stops half way, and a turn whose files go missing.
 *
 * Export has no size ceiling and import has one (`MAX_BACKUP_BYTES`), so an account past the ceiling can
 * write a file its own restore route refuses — and the one time that matters is the day the reader needs
 * the file back. The answer here is to let the export hand the data over and say on the response exactly
 * how big it is and what that means, and to make the refusal name the number and the way down. The
 * ceiling itself is set above the file the heaviest supported account writes, which is what the last
 * describe checks by round-tripping ten thousand to-dos through both routes.
 *
 * The second half is how a restore gets its rows in. One read and one to three writes per row, with no
 * transaction around any of it, is what makes a large file run out of the Worker's CPU between two rows
 * and leave half a library behind. Rows now go in as batches, and a restore that still stops between two
 * of them answers with what actually landed — a number this suite checks against the database itself.
 *
 * The third is `chatAttachments`, which clamped the ids it was handed to the per-message ceiling. The
 * conversation route calls it once for every chip on the page it is answering with, so a thread carrying
 * more files than one turn may hold lost the rest of them without a word.
 */
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_BACKUP_BYTES } from '@shared/assistant'
import { formatBytes } from '@shared/byte-format'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { newId } from '../src/worker/lib/id'
import { assistantRoutes } from '../src/worker/routes/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const SOURCE = '0123456789abcdefghjkmnpqrs'
const TARGET = '0123456789abcdefghjkmnpqrt'
/** Turns long enough, and wide enough, that the file they add up to is past the importable ceiling. */
const FAT_CHARS = 200_000
// Read off the ceiling rather than pinned beside it: four turns past the line the import draws, so this
// fixture keeps proving the refusal whenever the line moves — and stops being a four-megabyte story.
const FAT_TURNS = Math.ceil(MAX_BACKUP_BYTES / FAT_CHARS) + 4

/** What the D1 in front of the routes did, and where it was told to stop. */
const state = { trips: 0, failOnMessagesBatch: 0 }

/**
 * The D1 the routes see: a round-trip counter that can also break a batch.
 *
 * A restore is priced in round trips, not statements — one `db.batch` is a trip for eighty rows and one
 * `importRow().run()` is a trip for one — so counting `prepare` calls would not tell the two designs
 * apart. The fault is aimed at the messages batches because that is the largest table in a file, and the
 * one a big restore is most likely to be working through when it runs out of time.
 */
function instrument(inner: D1Database): D1Database {
  const sqlOf = new WeakMap<object, string>()
  let messagesBatches = 0
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement as unknown as Record<string, unknown>, {
    get(object, property) {
      if (property === 'inner') return statement
      // `bind` is not a round trip: it builds the statement the caller then executes. Counting it would
      // price a batched write at one trip per row and hide the very difference this counter measures.
      if (property === 'bind') {
        return (...binds: unknown[]) => wrap((object.bind as (...args: unknown[]) => D1PreparedStatement)(...binds))
      }
      const value = Reflect.get(object, property)
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      return (...args: unknown[]) => {
        state.trips++
        return method.apply(object, args)
      }
    },
  }) as unknown as D1PreparedStatement
  return new Proxy(inner as unknown as Record<string, unknown>, {
    get(object, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = (object as unknown as D1Database).prepare(sql)
          sqlOf.set(statement as unknown as object, sql)
          return wrap(statement)
        }
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          state.trips++
          // Unwrapped before the SQL is read: the statement handed to a batch is this file's own proxy,
          // and the script was recorded against the D1 statement underneath it.
          const unwrapped = statements.map((statement) => (statement as unknown as { inner?: D1PreparedStatement }).inner ?? statement)
          const scripts = unwrapped.map((statement) => sqlOf.get(statement as unknown as object) ?? '')
          if (state.failOnMessagesBatch > 0 && scripts.some((sql) => /INSERT OR IGNORE INTO chat_messages/.test(sql))) {
            messagesBatches++
            if (messagesBatches === state.failOnMessagesBatch) {
              return Promise.reject(new Error('simulated D1 failure between two batches'))
            }
          }
          return (object as unknown as D1Database).batch(unwrapped)
        }
      }
      return Reflect.get(object, property)
    },
  }) as unknown as D1Database
}

let sqlite: DatabaseSync
let env: Env
let app: Hono<AppBindings>
let store: AssistantStore
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext

/** Point the routes, the store and the counter at one account of the same database. */
function account(userId: string): void {
  env = testBindings(instrument(makeD1(sqlite)), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, userId, env)
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
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env, ctx)
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await respond(method, path, body)
  const text = await response.text()
  if (!response.ok) throw new Error(`${response.status} ${text}`)
  return JSON.parse(text || '{}') as T
}

/** Turns written straight to the table: the fixture is a long thread, not the store's write rules. */
function seedTurns(userId: string, conversationId: string, turns: number, content: string): void {
  const at = Date.now()
  const rows: string[] = []
  for (let index = 0; index < turns; index++) {
    rows.push(`('${newId()}', '${userId}', '${conversationId}', '${index % 2 === 0 ? 'user' : 'assistant'}', '${content}', ${at + index})`)
  }
  sqlite.exec(`INSERT INTO chat_messages (id, user_id, conversation_id, role, content, created_at) VALUES ${rows.join(', ')}`)
}

function count(table: string, userId: string): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId) as { n: number | bigint }
  return Number(row.n)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  state.trips = 0
  state.failOnMessagesBatch = 0
  account(SOURCE)
})

describe('an assistant backup past the size a restore can read', () => {
  /** The same account, exported: a file whose every byte is real and whose size is over the ceiling. */
  async function exportFatBackup(): Promise<{ response: Response, text: string }> {
    const conversation = await store.createConversation('Long enough to break')
    seedTurns(SOURCE, conversation.id, FAT_TURNS, 'a'.repeat(FAT_CHARS))
    const response = await respond('GET', '/api/assistant/export')
    return { response, text: await response.text() }
  }

  it('hands the file over and says on the response that a restore cannot read it', async () => {
    const { response, text } = await exportFatBackup()
    expect(response.status).toBe(200)
    const bytes = new TextEncoder().encode(text).byteLength
    expect(bytes).toBeGreaterThan(MAX_BACKUP_BYTES)
    // The size the reader is told is the size they got: a warning about a number nobody measured would be
    // the same lie in a different place.
    expect(Number(response.headers.get('x-backup-bytes'))).toBe(bytes)
    expect(response.headers.get('x-backup-importable')).toBe('false')
    const warning = response.headers.get('warning') ?? ''
    expect(warning).toContain(formatBytes(MAX_BACKUP_BYTES))
    expect(warning).toMatch(/export again/)
    // And it is not a truncated success: the whole library is in the bytes they were handed.
    const parsed = JSON.parse(text) as { data: { messages: unknown[] } }
    expect(parsed.data.messages).toHaveLength(FAT_TURNS)
  })

  it('refuses the same file with the limit and the way down named', async () => {
    const { text } = await exportFatBackup()
    account(TARGET)
    const response = await respond('POST', '/api/assistant/import', text)
    const body = await response.text()
    expect(response.status).toBe(413)
    expect(body).toContain(formatBytes(MAX_BACKUP_BYTES))
    expect(body).toMatch(/export again/)
    expect(count('chat_messages', TARGET)).toBe(0)
  })
})

describe('a restore of a whole library', () => {
  /** Threads and turns the file can be checked against, without four megabytes of padding. */
  async function seedLibrary(threads: number, turnsPerThread: number): Promise<void> {
    for (let thread = 0; thread < threads; thread++) {
      const conversation = await store.createConversation(`Thread ${thread}`)
      seedTurns(SOURCE, conversation.id, turnsPerThread, `Turn ${thread}`)
    }
  }

  it('lands every row, counts them as the file says, and does it in batches', async () => {
    await seedLibrary(120, 3)
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')
    const exported = payload.data as { conversations: unknown[], messages: unknown[] }
    expect(exported.conversations).toHaveLength(120)
    expect(exported.messages).toHaveLength(360)

    account(TARGET)
    state.trips = 0
    const summary = await call<{ imported: { conversations: number, messages: number } }>('POST', '/api/assistant/import', payload)
    // The counts are the rows that went in, so a summary that matches the file is a restore that finished.
    expect(summary.imported.conversations).toBe(exported.conversations.length)
    expect(summary.imported.messages).toBe(exported.messages.length)
    expect(count('chat_conversations', TARGET)).toBe(120)
    expect(count('chat_messages', TARGET)).toBe(360)
    // One read of what is already here and one batched write per chunk, not a round trip per row: this is
    // the number that decides whether a big restore finishes inside the Worker's budget or stops half way.
    expect(state.trips).toBeLessThan(80)
  })

  it('reports exactly what landed when it stops between two batches', async () => {
    await seedLibrary(40, 6)
    const payload = await call<Record<string, unknown>>('GET', '/api/assistant/export')

    account(TARGET)
    // The second of the messages batches is where a real restore runs out of CPU.
    state.failOnMessagesBatch = 2
    const response = await respond('POST', '/api/assistant/import', payload)
    const body = await response.text()
    expect(response.status).toBe(500)
    // The answer names the rows actually in the account, and the account is checked against it: a partial
    // restore that reports the wrong half is worse than one that reports nothing at all.
    const claimed = Number(/(\d+) messages had already landed/.exec(body)?.[1])
    expect(Number.isFinite(claimed), body).toBe(true)
    expect(claimed).toBe(count('chat_messages', TARGET))
    expect(claimed).toBeGreaterThan(0)
    expect(claimed).toBeLessThan(240)
    expect(body).toMatch(/Importing the same file again continues from there/)
    // The threads it had finished with are there, and nothing was left half-written inside one batch.
    expect(count('chat_conversations', TARGET)).toBe(40)

    // The same file again, with the fault gone, lands the rest and doubles nothing.
    state.failOnMessagesBatch = 0
    const second = await call<{ imported: { conversations: number, messages: number } }>('POST', '/api/assistant/import', payload)
    expect(second.imported.messages).toBe(240 - claimed)
    expect(second.imported.conversations).toBe(0)
    expect(count('chat_messages', TARGET)).toBe(240)
  })
})

describe('a turn that carries more files than one message may hold', () => {
  /** Files the account owns, and a row naming all of them — which is what a restore writes. */
  async function seedTurnWithAttachments(total: number): Promise<{ conversationId: string, ids: string[] }> {
    const conversation = await store.createConversation('Twelve files')
    const ids: string[] = []
    for (let index = 0; index < total; index++) {
      const id = newId()
      ids.push(id)
      await store.createChatAttachment({ id, kind: 'file', filename: `file-${index}.txt`, mime: 'text/plain', size: 10, key: `chat/files/${id}` })
    }
    await store.importRow('chat_messages', {
      id: newId(),
      conversation_id: conversation.id,
      role: 'user',
      content: 'All of these',
      // Every NOT NULL column of the row is named, exactly as the restore names them: `importRow` binds a
      // column it is not given as NULL, and `INSERT OR IGNORE` then drops the whole message.
      reasoning: '',
      tools: '[]',
      attachments: JSON.stringify(ids),
      status: 'complete',
      source: 'import',
      input_tokens: 0,
      output_tokens: 0,
      duration_ms: 0,
      model_label: '',
      sources: '[]',
      feedback: '',
      scopes: '[]',
      created_at: Date.now(),
    })
    return { conversationId: conversation.id, ids }
  }

  it('reads back every id it was asked for', async () => {
    const { ids } = await seedTurnWithAttachments(12)
    const rows = await store.chatAttachments(ids)
    expect(rows).toHaveLength(12)
    expect(rows.map((row) => row.id)).toEqual(ids)
    // Still scoped: a file of another account is not handed over because it was named.
    expect(await store.chatAttachments([ids[0]!, '0000000000000000000000000a'])).toHaveLength(1)
  })

  it('renders every chip in the transcript rather than the first eight', async () => {
    const { conversationId, ids } = await seedTurnWithAttachments(12)
    const detail = await call<{ messages: { attachments: string[] }[], attachments: { id: string }[] }>(
      'GET', `/api/assistant/conversations/${conversationId}`,
    )
    expect(detail.messages[0]?.attachments).toHaveLength(12)
    expect(detail.attachments).toHaveLength(12)
    expect(detail.attachments.map((row) => row.id)).toEqual(ids)
  })
})

describe('the account the ceiling was set for', () => {
  const TASKS = 10_000

  it('writes a ten-thousand-to-do file and reads every row of it back', async () => {
    // Ten thousand is the scale the to-do app's own stress passes use. Through this route the file it
    // writes is 8.13 MB pretty-printed (5.42 MB compact), which is what made the old four megabytes a
    // line a heavy reader crossed by using the app rather than by doing anything unusual.
    for (let index = 0; index < TASKS; index++) {
      await store.createTask({ title: `Task ${index}, written as long as a real one is` })
    }
    const exported = await respond('GET', '/api/assistant/export')
    const text = await exported.text()
    const bytes = new TextEncoder().encode(text).byteLength
    // The file is bigger than the ceiling this account used to be refused at, and the response says so
    // is importable rather than leaving the reader to find out on the restore.
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(exported.headers.get('x-backup-bytes')).toBe(String(bytes))
    expect(exported.headers.get('x-backup-importable')).toBe('true')

    account(TARGET)
    state.trips = 0
    const imported = await respond('POST', '/api/assistant/import', text)
    const importedBody = await imported.text()
    expect(imported.status, importedBody).toBe(200)
    const summary = JSON.parse(importedBody) as { imported: { tasks: number } }
    expect(summary.imported.tasks).toBe(TASKS)
    expect(count('todos_tasks', TARGET)).toBe(TASKS)
    // Rows go in as batches, so the round trips are counted in chunks and not in tasks: this is the
    // number that decides whether the restore finishes inside the Worker's budget at all.
    expect(state.trips).toBeLessThan(TASKS / 10)
  }, 300_000)
})

// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'
const OTHER = 'user-bob'
const OWN_NOTE = 'a'.repeat(26)
const FOREIGN_NOTE = 'b'.repeat(26)

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, created_at, updated_at) VALUES (?, ?, '', 1, 1)`).run(OWN_NOTE, USER)
  sqlite.prepare(`INSERT INTO notes (id, user_id, title, created_at, updated_at) VALUES (?, ?, '', 1, 1)`).run(FOREIGN_NOTE, OTHER)
})

describe('task references', () => {
  it('accepts this account’s note and conversation', async () => {
    const conversation = await store.createConversation('Source')
    const task = await store.createTask({ title: 'Linked', noteId: OWN_NOTE, conversationId: conversation.id })
    expect(task.noteId).toBe(OWN_NOTE)
    expect(task.conversationId).toBe(conversation.id)
  })

  it('refuses a foreign note on create and update', async () => {
    await expect(store.createTask({ title: 'No', noteId: FOREIGN_NOTE })).rejects.toMatchObject({ status: 404 })
    const task = await store.createTask({ title: 'Mine' })
    await expect(store.updateTask(task.id, { noteId: FOREIGN_NOTE })).rejects.toMatchObject({ status: 404 })
    expect((await store.getTask(task.id))?.noteId).toBeNull()
  })

  it('refuses a foreign conversation on create and update', async () => {
    const foreign = await new AssistantStore(env.DB as D1Database, OTHER, env).createConversation('Theirs')
    await expect(store.createTask({ title: 'No', conversationId: foreign.id })).rejects.toMatchObject({ status: 404 })
    const task = await store.createTask({ title: 'Mine' })
    await expect(store.updateTask(task.id, { conversationId: foreign.id })).rejects.toMatchObject({ status: 404 })
    expect((await store.getTask(task.id))?.conversationId).toBeNull()
  })
})

describe('D1 LIKE patterns', () => {
  it('keeps every generated pattern within the 50-byte hosted limit', async () => {
    const inner = env.DB as D1Database
    const guarded = {
      prepare(sql: string) {
        const statement = inner.prepare(sql)
        const wrapped = {
          bind(...values: unknown[]) {
            for (const value of values) {
              if (typeof value === 'string' && value.startsWith('%') && Buffer.byteLength(value, 'utf8') > 50) {
                throw new Error(`pattern too large: ${Buffer.byteLength(value, 'utf8')}`)
              }
            }
            statement.bind(...values)
            return wrapped
          },
          async first<T>() { return statement.first<T>() },
          async all<T>() { return statement.all<T>() },
          async run<T>() { return statement.run<T>() },
          async raw<T>() { return statement.raw<T>() },
        }
        return wrapped
      },
      batch: (statements: never[]) => inner.batch(statements),
    } as unknown as D1Database
    const guardedStore = new AssistantStore(guarded, USER, env)

    await expect(guardedStore.listTasks({ query: '汉'.repeat(30) })).resolves.toEqual([])
    await expect(guardedStore.resolveTask('汉'.repeat(30))).resolves.toBeNull()
  })
})

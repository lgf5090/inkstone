// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'
const HOUR = 60 * 60 * 1000

let sqlite: DatabaseSync
let env: Env

/**
 * The same D1 double, with one table's inserts refused.
 *
 * A create writes its children one door at a time — tags in a batch, steps and reminders one
 * statement each — so the honest question is what stands when the last of those doors fails. The
 * refusal is raised from `run()`, which is the verb the step and reminder inserts go through; the
 * batch door keeps working, because that is where a tag write really goes.
 */
function refusingInserts(inner: D1Database, table: string): D1Database {
  return {
    prepare(sql: string) {
      const statement = inner.prepare(sql)
      const wrapped = {
        bind(...values: unknown[]) {
          statement.bind(...values)
          return wrapped
        },
        async first<T>() { return statement.first<T>() },
        async all<T>() { return statement.all<T>() },
        async run<T>() {
          if (sql.includes(`INSERT INTO ${table}`)) throw new Error(`${table} refused the write`)
          return statement.run<T>()
        },
        async raw<T>() { return statement.raw<T>() },
      }
      return wrapped
    },
    batch: (prepared: never[]) => inner.batch(prepared),
  } as unknown as D1Database
}

function count(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('a create whose child write fails', () => {
  it('leaves no half-written task behind', async () => {
    const store = new AssistantStore(refusingInserts(env.DB as D1Database, 'todos_reminders'), USER, env)

    await expect(store.createTask({
      title: 'Plan the offsite',
      tags: ['Work'],
      steps: ['Book the room'],
      reminders: [Date.now() + HOUR],
    })).rejects.toThrow('todos_reminders refused the write')

    // The row, its birth, its steps, its tag links and its reminders all go with the failed write:
    // a task that answered with only some of what was asked for is a task nobody created. The tag
    // itself stays — it may have been the account's before this create, and an unused tag is a row
    // the tag page already knows how to show.
    expect(count('todos_tasks')).toBe(0)
    expect(count('todos_task_events')).toBe(0)
    expect(count('todos_steps')).toBe(0)
    expect(count('todos_tag_links')).toBe(0)
    expect(count('todos_reminders')).toBe(0)
  })

  it('leaves no half-written task when the step insert is the one that fails', async () => {
    const store = new AssistantStore(refusingInserts(env.DB as D1Database, 'todos_steps'), USER, env)

    await expect(store.createTask({
      title: 'Plan the offsite',
      tags: ['Work'],
      steps: ['Book the room'],
    })).rejects.toThrow('todos_steps refused the write')

    expect(count('todos_tasks')).toBe(0)
    expect(count('todos_task_events')).toBe(0)
    expect(count('todos_tag_links')).toBe(0)
  })

  it('still writes the whole task when every child lands', async () => {
    // The rollback must not become the failure mode: the cheap create is still all-or-nothing the
    // other way too, and the statement budget it is held to is unchanged by the guard around it.
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const due = Date.parse('2026-10-20T09:00:00Z')

    const task = await store.createTask({
      title: 'Plan the offsite',
      dueAt: due,
      tags: ['Work'],
      steps: ['Book the room'],
      reminders: [due - HOUR],
    })

    expect(task.stepTotal).toBe(1)
    expect(task.tags.map((tag) => tag.name)).toEqual(['Work'])
    expect(task.reminders).toEqual([due - HOUR])
    expect(await store.getTask(task.id)).toEqual(task)
  })
})

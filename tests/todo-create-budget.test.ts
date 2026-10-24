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
 * The D1 double with a tally of the statements that actually run.
 *
 * A prepared statement is counted when it executes, not when it is built, so a batch's statements
 * are counted one by one through the same wrappers. That is the number the create path is held to:
 * one round trip that carries six statements still costs six.
 */
function countingD1(inner: D1Database): { db: D1Database; count: () => number } {
  let statements = 0
  const db = {
    prepare(sql: string) {
      const statement = inner.prepare(sql)
      const wrapped = {
        bind(...values: unknown[]) {
          statement.bind(...values)
          return wrapped
        },
        async first<T>() {
          statements++
          return statement.first<T>()
        },
        async all<T>() {
          statements++
          return statement.all<T>()
        },
        async run<T>() {
          statements++
          return statement.run<T>()
        },
        async raw<T>() {
          statements++
          return statement.raw<T>()
        },
      }
      return wrapped
    },
    async batch(prepared: D1PreparedStatement[]) {
      // Each prepared statement runs through .all(), which the wrapper above counts.
      return inner.batch(prepared as never)
    },
  } as unknown as D1Database
  return { db, count: () => statements }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

describe('what one create costs', () => {
  it('writes five steps, three tags and two reminders in ten statements or fewer', async () => {
    const { db, count } = countingD1(env.DB as D1Database)
    const store = new AssistantStore(db, USER, env)
    const due = Date.parse('2026-10-20T09:00:00Z')

    const task = await store.createTask({
      title: 'Plan the offsite',
      dueAt: due,
      tags: ['Work', 'Travel', 'Urgent'],
      steps: ['Book the room', 'Send invites', 'Collect topics', 'Draft agenda', 'Share notes'],
      reminders: [due - 2 * HOUR, due - HOUR],
    })

    expect(count()).toBeLessThanOrEqual(10)
    // The cheap write is still the whole task: every child row is there and the row read carries them.
    expect(task.stepTotal).toBe(5)
    expect(task.stepDone).toBe(0)
    expect(task.tags.map((tag) => tag.name)).toEqual(['Travel', 'Urgent', 'Work'])
    expect(task.reminders).toEqual([due - 2 * HOUR, due - HOUR])
    expect(task.remindAt).toBe(due - 2 * HOUR)
    expect(await store.listSteps(task.id)).toHaveLength(5)
    expect((await store.listTaskTags()).map((tag) => tag.name).sort()).toEqual(['Travel', 'Urgent', 'Work'])
    // The cheap read-back is the same shape a full read answers, field for field.
    expect(await store.getTask(task.id)).toEqual(task)
  })

  it('reuses the tags the account already has instead of creating them again', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const first = await store.createTask({ title: 'First', tags: ['Work', 'Life'] })
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_tags').get() as { n: number }

    const { db, count } = countingD1(env.DB as D1Database)
    const counting = new AssistantStore(db, USER, env)
    const second = await counting.createTask({ title: 'Second', tags: ['work', 'Errand'] })

    expect(count()).toBeLessThanOrEqual(10)
    expect((sqlite.prepare('SELECT COUNT(*) AS n FROM todos_tags').get() as { n: number }).n).toBe(before.n + 1)
    expect(second.tags.map((tag) => tag.name)).toEqual(['Errand', 'Work'])
    // The reused tag is the same row, not a case-different duplicate.
    const work = first.tags.find((tag) => tag.name === 'Work')!
    expect(second.tags.find((tag) => tag.name === 'Work')!.id).toBe(work.id)
  })

  it('keeps the step ceiling and drops the overflow as addStep did', async () => {
    const store = new AssistantStore(env.DB as D1Database, USER, env)
    const texts = Array.from({ length: 55 }, (_, index) => `Step ${index + 1}`)

    const task = await store.createTask({ title: 'Long list', steps: texts })

    expect(task.stepTotal).toBe(50)
    const steps = await store.listSteps(task.id)
    expect(steps).toHaveLength(50)
    expect(steps[0]!.text).toBe('Step 1')
    expect(steps[49]!.text).toBe('Step 50')
    expect(steps.map((step) => step.position)).toEqual(Array.from({ length: 50 }, (_, index) => index))
  })
})

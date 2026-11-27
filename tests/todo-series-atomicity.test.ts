// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = 'user-alice'
const DUE = Date.parse('2026-10-20T09:00:00Z')

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

function count(sql: string): number {
  return (sqlite.prepare(sql).get() as { n: number }).n
}

function barrierTaskReads(inner: D1Database): D1Database {
  let reads = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    prepare(sql: string) {
      const statement = inner.prepare(sql)
      const wrapped = {
        bind(...values: unknown[]) { statement.bind(...values); return wrapped },
        async first<T>() {
          if (sql.includes('FROM todos_tasks') && sql.includes('reminder_times')) {
            reads += 1
            if (reads === 2) release()
            if (reads <= 2) await gate
          }
          return statement.first<T>()
        },
        async all<T>() { return statement.all<T>() },
        async run<T>() { return statement.run<T>() },
        async raw<T>() { return statement.raw<T>() },
      }
      return wrapped
    },
    batch: (statements: never[]) => inner.batch(statements),
  } as unknown as D1Database
}

function refuseStepInserts(inner: D1Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = inner.prepare(sql)
      const wrapped = {
        bind(...values: unknown[]) { statement.bind(...values); return wrapped },
        async first<T>() { return statement.first<T>() },
        async all<T>() {
          if (sql.includes('INSERT INTO todos_steps')) throw new Error('step insert refused')
          return statement.all<T>()
        },
        async run<T>() { return statement.run<T>() },
        async raw<T>() { return statement.raw<T>() },
      }
      return wrapped
    },
    batch: (statements: never[]) => inner.batch(statements),
  } as unknown as D1Database
}

describe('a repeating completion', () => {
  it('files only one successor when two completions race', async () => {
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: DUE,
      repeat: { freq: 'weekly', interval: 1 },
      tags: ['Work'],
      steps: ['Collect numbers'],
      reminders: [DUE - 60 * 60_000],
    })
    const raced = new AssistantStore(barrierTaskReads(env.DB as D1Database), USER, env)

    const results = await Promise.allSettled([
      raced.completeTask(task.id, 'UTC'),
      raced.completeTask(task.id, 'UTC'),
    ])

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    expect(count('SELECT COUNT(*) AS n FROM todos_tasks')).toBe(2)
    expect(count("SELECT COUNT(*) AS n FROM todos_tasks WHERE status = 'todo'")).toBe(1)
    expect(count("SELECT COUNT(*) AS n FROM todos_task_events WHERE kind = 'status' AND to_status = 'done'")).toBe(1)
    const next = await store.listTasks({ view: 'open', limit: 10 })
    expect(next).toHaveLength(1)
    expect(next[0]?.tags.map((tag) => tag.name)).toEqual(['Work'])
    expect(next[0]?.stepTotal).toBe(1)
    expect(next[0]?.reminders).toHaveLength(1)
  })

  it('does not file another successor after a completed occurrence is reopened', async () => {
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: DUE,
      repeat: { freq: 'weekly', interval: 1 },
    })

    const first = await store.completeTask(task.id, 'UTC')
    expect(first?.next).not.toBeNull()
    await store.updateTask(task.id, { status: 'todo' })
    const second = await store.completeTask(task.id, 'UTC')

    expect(second?.next).toBeNull()
    expect(count('SELECT COUNT(*) AS n FROM todos_tasks')).toBe(2)
    expect(count("SELECT COUNT(*) AS n FROM todos_tasks WHERE status = 'todo'")).toBe(1)
  })

  it('rolls the completion back when the successor cannot be written', async () => {
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: DUE,
      repeat: { freq: 'weekly', interval: 1 },
      steps: ['Collect numbers'],
    })
    const failing = new AssistantStore(refuseStepInserts(env.DB as D1Database), USER, env)

    await expect(failing.completeTask(task.id, 'UTC')).rejects.toThrow('step insert refused')

    expect((await store.getTask(task.id))?.status).toBe('todo')
    expect(count('SELECT COUNT(*) AS n FROM todos_tasks')).toBe(1)
    expect(count("SELECT COUNT(*) AS n FROM todos_task_events WHERE kind = 'status'")).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM todos_steps')).toBe(1)
  })
})

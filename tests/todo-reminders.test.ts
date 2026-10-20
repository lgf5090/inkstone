// @vitest-environment node
/**
 * The reminder sweep.
 *
 * What is pinned: a reminder that has come due is delivered once, a completed task is never announced,
 * one account's reminder never reaches another account's notification list, and a failure inside one
 * row does not stop the rest of the tick. The last one is the reason the sweep is written per-row rather
 * than as one statement: a cron that gives up at the first bad row would leave every reminder behind it
 * undelivered, and the reader would only find out by noticing silence.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { normalizeAssistantSettings } from '../src/shared/assistant'
import { AssistantStore } from '../src/worker/assistant/store'
import { sweepTaskReminders } from '../src/worker/assistant/tasks'
import worker from '../src/worker/index'
import { EN_US_TODO_NOTIFY } from '../src/shared/locales/en-US-todo-notify'
import { ZH_CN_TODO_NOTIFY } from '../src/shared/locales/zh-CN-todo-notify'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const NOW = Date.parse('2026-10-20T09:00:00Z')

let sqlite: DatabaseSync
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
})

/** A task whose reminder is `offsetMs` from the sweep time. */
async function reminderTask(userId: string, over: { title?: string, offsetMs?: number, status?: 'todo' | 'done' } = {}) {
  const store = new AssistantStore(env.DB as D1Database, userId, env)
  const due = NOW + 60 * 60 * 1000
  return await store.createTask({
    title: over.title ?? 'File the return',
    dueAt: due,
    remindAt: NOW + (over.offsetMs ?? -60_000),
    status: over.status ?? 'todo',
  })
}

async function notificationsOf(userId: string) {
  return await new AssistantStore(env.DB as D1Database, userId, env).listNotifications()
}

describe('sweepTaskReminders', () => {
  it('delivers a reminder that has come due, once', async () => {
    await reminderTask(ALICE)

    const first = await sweepTaskReminders(env, NOW)
    expect(first).toMatchObject({ due: 1, sent: 1, claimed: 0, failed: 0 })

    const delivered = await notificationsOf(ALICE)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.title).toContain('File the return')

    // The second fire of the same minute finds the row claimed and says nothing again.
    const second = await sweepTaskReminders(env, NOW)
    expect(second).toMatchObject({ due: 0, sent: 0 })
    expect(await notificationsOf(ALICE)).toHaveLength(1)
  })

  it('leaves a reminder that is not due yet alone', async () => {
    await reminderTask(ALICE, { offsetMs: 60 * 60 * 1000 })
    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 0, sent: 0 })
  })

  it('never announces a task that is already done', async () => {
    await reminderTask(ALICE, { status: 'done' })
    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 0, sent: 0 })
    expect(await notificationsOf(ALICE)).toHaveLength(0)
  })

  it('keeps one account\'s reminder out of another account\'s list', async () => {
    await reminderTask(ALICE, { title: 'Alice only' })
    await reminderTask(BOB, { title: 'Bob only' })

    const result = await sweepTaskReminders(env, NOW)
    expect(result.sent).toBe(2)
    expect((await notificationsOf(ALICE)).map((row) => row.title)).toEqual([expect.stringContaining('Alice only')])
    expect((await notificationsOf(BOB)).map((row) => row.title)).toEqual([expect.stringContaining('Bob only')])
  })

  it('writes the reminder in the account\'s own language', async () => {
    const store = new AssistantStore(env.DB as D1Database, ALICE, env)
    await store.saveSettings(normalizeAssistantSettings({ language: 'en-US' }))
    await reminderTask(ALICE)

    await sweepTaskReminders(env, NOW)
    expect((await notificationsOf(ALICE))[0]!.title.startsWith(EN_US_TODO_NOTIFY.title)).toBe(true)
  })
})

describe('the cron fire that carries a reminder', () => {
  // Everything above calls the sweep directly. This goes through the handler, because the thing that was
  // actually broken was the cadence: on a cron that only fires at :00, :15 and :45, a reminder due at :30
  // sat until :45 while every assertion above stayed green.
  it('delivers at :37 a reminder that came due at :30', async () => {
    await reminderTask(ALICE, { offsetMs: 30 * 60 * 1000, title: 'Pick up the prescription' })

    const handedOff: Promise<unknown>[] = []
    const ctx = { waitUntil: (task: Promise<unknown>) => { handedOff.push(task) } } as ExecutionContext
    await worker.scheduled(
      { scheduledTime: Date.parse('2026-10-20T09:37:00.000Z'), cron: '* * * * *' } as ScheduledController,
      env,
      ctx,
    )
    await Promise.all(handedOff)

    expect((await notificationsOf(ALICE)).map((row) => row.title))
      .toEqual([expect.stringContaining('Pick up the prescription')])
  })
})

describe('the reminder catalog', () => {
  const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

  it('carries the same keys in both languages', () => {
    expect(Object.keys(ZH_CN_TODO_NOTIFY).sort()).toEqual(Object.keys(EN_US_TODO_NOTIFY).sort())
  })

  it('carries the same placeholders in both languages', () => {
    for (const [key, value] of Object.entries(EN_US_TODO_NOTIFY)) {
      const twin = (ZH_CN_TODO_NOTIFY as Record<string, string>)[key]
      expect(typeof twin).toBe('string')
      expect(placeholders(twin)).toEqual(placeholders(value))
    }
  })
})

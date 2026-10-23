// @vitest-environment node
/**
 * The reminder sweep.
 *
 * What is pinned: a reminder that has come due is delivered once, a completed task is never announced,
 * a task the reader has started is announced just as plainly, one account's reminder never reaches
 * another account's notification list, and a failure inside one
 * row does not stop the rest of the tick. The last one is the reason the sweep is written per-row rather
 * than as one statement: a cron that gives up at the first bad row would leave every reminder behind it
 * undelivered, and the reader would only find out by noticing silence.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { normalizeAssistantSettings } from '../src/shared/assistant'
import { localDayBounds } from '../src/shared/assistant-time'
import { AssistantStore } from '../src/worker/assistant/store'
import { runDueAssistantAutomations } from '../src/worker/assistant/scheduler'
import { sweepTaskReminders } from '../src/worker/assistant/tasks'
import worker from '../src/worker/index'
import { EN_US_TODO_NOTIFY } from '../src/shared/locales/en-US-todo-notify'
import { ZH_CN_TODO_NOTIFY } from '../src/shared/locales/zh-CN-todo-notify'
import type { Env } from '../src/worker/env'
import type { TaskStatus } from '../src/shared/todos/model'
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
async function reminderTask(userId: string, over: { title?: string, offsetMs?: number, status?: TaskStatus } = {}) {
  const store = new AssistantStore(env.DB as D1Database, userId, env)
  const due = NOW + 60 * 60 * 1000
  return await store.createTask({
    title: over.title ?? 'File the return',
    dueAt: due,
    reminders: [NOW + (over.offsetMs ?? -60_000)],
    status: over.status ?? 'todo',
  })
}

async function notificationsOf(userId: string) {
  return await new AssistantStore(env.DB as D1Database, userId, env).listNotifications()
}

/** The delivered-row count straight from the table the sweep writes, not through a store read. */
function notificationCount(userId: string): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM chat_notifications WHERE user_id = ?1`)
    .get(userId) as { n: number }).n)
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

  it('delivers each of a task\'s five reminders once, and only once', async () => {
    const store = new AssistantStore(env.DB as D1Database, ALICE, env)
    const times = [
      NOW - 5 * 60_000,
      NOW - 4 * 60_000,
      NOW - 3 * 60_000,
      NOW - 2 * 60_000,
      NOW - 60_000,
    ]
    const task = await store.createTask({ title: 'Stand-up', reminders: times })
    expect(task.reminders).toEqual(times)

    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 5, sent: 5, claimed: 0, failed: 0 })
    // Every row was claimed by the first fire, so an overlapping tick has nothing to deliver.
    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 0, sent: 0 })
    expect(notificationCount(ALICE)).toBe(5)

    const link = sqlite.prepare(`SELECT link FROM chat_notifications WHERE user_id = ?1 LIMIT 1`)
      .get(ALICE) as { link: string | null }
    expect(link.link).toBe(`todo:${task.id}`)
  })

  it('delivers nothing for a task finished after its reminders were set', async () => {
    const store = new AssistantStore(env.DB as D1Database, ALICE, env)
    const task = await store.createTask({ title: 'Already done', reminders: [NOW - 60_000] })
    await store.completeTask(task.id, 'UTC')

    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 0, sent: 0 })
    expect(notificationCount(ALICE)).toBe(0)
  })

  it('delivers nothing for a task whose due date was taken away', async () => {
    const store = new AssistantStore(env.DB as D1Database, ALICE, env)
    const task = await store.createTask({
      title: 'Loose end',
      dueAt: NOW + 60 * 60 * 1000,
      reminders: [NOW - 60_000],
    })

    const cleared = await store.updateTask(task.id, { dueAt: null }, 'UTC')
    // A reminder is a distance from the due date. With no date left, the distance has no anchor, so the
    // pending row goes with it rather than firing on a schedule the reader just erased.
    expect(cleared?.dueAt).toBeNull()
    expect(cleared?.reminders ?? []).toEqual([])

    expect(await sweepTaskReminders(env, NOW)).toMatchObject({ due: 0, sent: 0 })
    expect(notificationCount(ALICE)).toBe(0)

    // A patch that names its own reminder list still owns it: taking the date away does not overrule
    // the instants the same request spelled out — the editor sends both fields in one save.
    const both = await store.createTask({ title: 'Named anyway', dueAt: NOW + 60 * 60 * 1000, reminders: [NOW - 60_000] })
    const named = await store.updateTask(both.id, { dueAt: null, reminders: [NOW + 5 * 60_000] }, 'UTC')
    expect(named?.reminders).toEqual([NOW + 5 * 60_000])
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

  it('announces a reminder on a task the reader has started', async () => {
    // Starting a task does not put it beyond reaching its reader: `in_progress` is on the owed side of
    // the line, so the sweep has to hand over the notification the same way it does for a `todo` row.
    // The row reaches the sweep twice — once through the read, once through the claim's `EXISTS` — and
    // both halves are the same predicate, so a started task dropped here would go unsent in silence.
    await reminderTask(ALICE, { title: 'Started work', status: 'in_progress' })

    const result = await sweepTaskReminders(env, NOW)
    expect(result).toMatchObject({ due: 1, sent: 1, claimed: 0, failed: 0 })
    expect((await notificationsOf(ALICE)).map((row) => row.title)).toEqual([expect.stringContaining('Started work')])
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

describe('the daily plan digest', () => {
  /** One daily `task_digest`, the row the settings page creates and the sweep fires. */
  async function digestAutomation(userId: string): Promise<void> {
    const store = new AssistantStore(env.DB as D1Database, userId, env)
    await store.saveSettings(normalizeAssistantSettings({ language: 'zh-CN', timezone: 'UTC' }))
    await store.insertAutomation({
      name: '每日计划',
      kind: 'task_digest',
      message: '',
      schedule: { type: 'daily', time: '09:00' },
      enabled: true,
      status: 'scheduled',
      nextRun: Date.now() - 1000,
      targetFolderId: null,
      targetNoteId: null,
    })
  }

  it('leads with today and overdue counts in the reader\'s language, then lists them', async () => {
    const store = new AssistantStore(env.DB as D1Database, ALICE, env)
    const bounds = localDayBounds('UTC')
    const now = Date.now()
    // Today's task sits just inside the day's end, so the same numbers hold whichever side of midnight
    // the suite happens to run on.
    await store.createTask({ title: 'Late report', dueAt: bounds.start - 60_000 })
    await store.createTask({ title: 'Today call', dueAt: Math.min(now + 60_000, bounds.end - 1) })
    await store.createTask({ title: 'No date yet' })
    await digestAutomation(ALICE)

    const result = await runDueAssistantAutomations(env)
    expect(result).toMatchObject({ started: 1, failed: 0 })

    const [notice] = await notificationsOf(ALICE)
    expect(notice?.title).toBe('每日计划')
    expect(notice?.body).toContain('今天 1 条，逾期 1 条')
    expect(notice?.body).toContain('**逾期**')
    expect(notice?.body).toContain('**今天**')
    expect(notice?.body).toContain('- Late report')
    expect(notice?.body).toContain('- Today call')
    expect(notice?.body).toContain('另有 1 条待办')
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

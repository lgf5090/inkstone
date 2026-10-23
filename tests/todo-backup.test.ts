// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { exportAssistant, importAssistant } from '../src/worker/assistant/backup'
import { linkTodoAttachment, listTodoAttachments } from '../src/worker/todos/schema'
import {
  addCounterTick,
  createCounter,
  getCounter,
  listCounters,
  startCounterTimer,
} from '../src/worker/todos/counters'
import { addDays, eachDay } from '../src/worker/todos/stats'
import {
  COUNTER_WINDOW_DAYS,
  MAX_COUNTERS_PER_ACCOUNT,
  MAX_COUNTER_DAY_AMOUNT,
} from '../src/shared/todos/model'
import { newId } from '../src/worker/lib/id'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * A backup carries the to-do app's own objects, not just the task rows.
 *
 * A task restored without its list, tags or steps is a different task, and the reader would have no
 * way to tell that the file had held more. The round trip here is the only thing that proves the
 * export columns and the import row agree — the failure mode otherwise is silent, because
 * `INSERT OR IGNORE` drops a row rather than complaining.
 */

const USER = 'user-alice'
const OTHER = 'user-bob'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

/** The two day columns, read where they live: the task's own shape does not carry them. */
function taskDays(userId: string, taskId: string): { created_on: string | null, completed_on: string | null } {
  return sqlite.prepare(
    `SELECT created_on, completed_on FROM todos_tasks WHERE user_id = ?1 AND id = ?2`,
  ).get(userId, taskId) as { created_on: string | null, completed_on: string | null }
}

/** How many alarms one account is still owed: the row count, not what a task read chooses to show. */
function pendingReminderCount(userId: string): number {
  const row = sqlite.prepare(
    `SELECT COUNT(*) AS n FROM todos_reminders WHERE user_id = ?1 AND fired_at IS NULL`,
  ).get(userId) as { n: number | bigint }
  return Number(row.n)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

describe('a backup round trip', () => {
  it('restores lists, tags, steps and every task field', async () => {
    const list = await store.createTaskList({ name: 'Work', icon: 'Briefcase', color: '#2563eb' })
    const due = Date.parse('2026-10-20T09:00:00Z')
    const task = await store.createTask({
      title: 'File the return',
      description: 'Before the deadline',
      priority: 'urgent',
      dueAt: due,
      listId: list.id,
      starred: true,
      repeat: { freq: 'monthly', interval: 2 },
      remindAt: due - 60 * 60 * 1000,
      noteId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      conversationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      tags: ['Tax', 'Urgent'],
      steps: ['Collect receipts', 'Fill the form'],
    })
    const steps = await store.listSteps(task.id)
    await store.updateStep(task.id, steps[1]!.id, { done: true })

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    const lists = await target.listTaskLists()
    expect(lists).toHaveLength(1)
    expect(lists[0]).toMatchObject({ name: 'Work', icon: 'Briefcase', color: '#2563eb' })

    const restored = await target.getTask(task.id)
    expect(restored).toMatchObject({
      title: 'File the return',
      description: 'Before the deadline',
      priority: 'urgent',
      dueAt: due,
      starred: true,
      repeat: { freq: 'monthly', interval: 2 },
      remindAt: due - 60 * 60 * 1000,
      noteId: 'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      conversationId: 'bbbbbbbbbbbbbbbbbbbbbbbbbb',
      listId: list.id,
      stepTotal: 2,
      stepDone: 1,
    })
    expect(restored?.tags.map((tag) => tag.name).sort()).toEqual(['Tax', 'Urgent'])

    const restoredSteps = await target.listSteps(task.id)
    expect(restoredSteps.map((step) => [step.text, step.done])).toEqual([
      ['Collect receipts', false],
      ['Fill the form', true],
    ])
  })

  // The shelf travels, unlike the trash. A file is a snapshot of what the account still has, and work
  // the reader put away is still theirs — a restore that lost the stamp would drop the whole reason for
  // the shelf and refill today's board with the days they have already closed. This is the only case
  // that proves `EXPORT_COLUMNS` and the export row agree for this column, because `INSERT OR IGNORE`
  // drops a mismatched row quietly and a missing key lands it back at the column's default of NULL.
  it('restores a task still on the shelf it was put away on', async () => {
    const stamp = Date.parse('2026-10-22T20:00:00Z')
    const task = await store.createTask({ title: 'Old quarter', status: 'done', archivedAt: stamp })

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    const restored = await target.getTask(task.id)
    expect(restored).toMatchObject({ title: 'Old quarter', status: 'done', archivedAt: stamp })
    // And the shelf still means the shelf on the machine that received the file: the row is readable
    // by id above, and nowhere in a listing the reader browses.
    expect((await target.listTasks({ view: 'all' })).map((row) => row.id)).not.toContain(task.id)
  })

  // A section of a list *is* a child list in this app, so `parent_id` is the shape of the page rather
  // than a decoration: a file that lost it comes back as a flat pile of collections, and a file that
  // lost `archived_at` puts a put-away list back on the working page. Both columns are nullable, so a
  // dropped key lands at NULL and nothing complains — which is why this is proved by the round trip.
  it('restores which list a section belongs to, and which lists were put away', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const section = await store.createTaskList({ name: 'Billing' })
    const shelved = await store.createTaskList({ name: 'Old gigs' })
    const stamp = Date.parse('2026-10-21T09:00:00Z')
    await store.updateTaskList(section.id, { parentId: parent.id })
    await store.updateTaskList(shelved.id, { archivedAt: stamp })
    const filed = await store.createTask({ title: 'Send the invoice', listId: section.id })

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    expect(await target.getTask(filed.id)).toMatchObject({ listId: section.id })
    expect((await target.listTaskLists()).find((entry) => entry.id === section.id))
      .toMatchObject({ parentId: parent.id, archivedAt: null })
    const onTheShelf = await target.listTaskLists({ archived: true })
    expect(onTheShelf.find((entry) => entry.id === shelved.id)?.archivedAt).toBe(stamp)
    // The shelf still means the shelf on the machine that received the file.
    expect((await target.listTaskLists()).map((entry) => entry.id)).not.toContain(shelved.id)
  })

  it('levels a section whose parent the file does not carry', async () => {
    const parent = await store.createTaskList({ name: 'Client work' })
    const section = await store.createTaskList({ name: 'Billing' })
    await store.updateTaskList(section.id, { parentId: parent.id })

    const backup = JSON.parse(JSON.stringify(await exportAssistant(store))) as { data: Record<string, unknown[]> }
    // A hand-edited file, or one whose parent was pruned: the child comes back at the top level rather
    // than naming a list no restore can create, because a dangling parent is a section nobody can open.
    backup.data.task_lists = (backup.data.task_lists as Record<string, unknown>[])
      .filter((entry) => entry.id !== parent.id)

    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    // Re-read through the same door the route would: what comes back from `JSON.parse` is the shape the
    // importer is written against, so the test hands it a file rather than an object it made up.
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    const restored = (await target.listTaskLists()).find((entry) => entry.id === section.id)
    expect(restored?.parentId, 'a child of a missing parent stayed nested').toBeNull()
    expect(restored?.name).toBe('Billing')
  })

  // The export takes `SELECT *` and the reader enumerates the columns it writes back, so the two agree
  // only by somebody remembering. Five columns and one whole status were not remembered: a task that
  // had been abandoned came back owed, and one with a start, a face of its own and a plan came back
  // with none of them — every one of those lands silently, because a missing key is what the nullable
  // columns are for.
  it('restores every column of a task the file carries', async () => {
    const due = Date.parse('2026-10-20T09:00:00Z')
    const task = await store.createTask({
      title: 'Quarter close',
      status: 'cancelled',
      priority: 'high',
      dueAt: due,
      startAt: due - 2 * 60 * 60 * 1000,
      icon: 'lucide:Timer',
      color: '#2563eb',
      timeEstimateMs: 90 * 60 * 1000,
    })

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    const restored = await target.getTask(task.id)
    expect(restored).toMatchObject({
      title: 'Quarter close',
      // Abandoning a task is an answer the reader gave; restoring it as `todo` hands the debt back and
      // moves a number on the statistics page at the same time.
      status: 'cancelled',
      priority: 'high',
      dueAt: due,
      startAt: due - 2 * 60 * 60 * 1000,
      icon: 'lucide:Timer',
      color: '#2563eb',
      timeEstimateMs: 90 * 60 * 1000,
    })
    // The two day columns are what the buckets and the streak read, and a restore that lost them left
    // every restored task with no day at all until a boot backfilled it — which, after a restore, the
    // fingerprint note says does not come back through.
    expect(taskDays(OTHER, task.id)).toEqual(taskDays(USER, task.id))
    expect(taskDays(OTHER, task.id).created_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('refuses a day the file spells wrong rather than filing the task under it', async () => {
    const task = await store.createTask({ title: 'Bad day', status: 'done' })

    const backup = await exportAssistant(store)
    const file = JSON.parse(JSON.stringify(backup)) as { data: { tasks: Record<string, unknown>[] } }
    const row = file.data.tasks.find((entry) => entry.id === task.id)!
    // A year, not a day: `completed_on` is matched as a string against a computed today, so the loose
    // shape does not sort under the wrong day, it sorts under none at all.
    row.created_on = '2026'
    row.completed_on = '2026-10'

    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, file)

    const restored = await target.getTask(task.id)
    expect(restored).toMatchObject({ title: 'Bad day', status: 'done' })
    expect(taskDays(OTHER, task.id)).toEqual({ created_on: null, completed_on: null })
  })

  it('leaves a task in the inbox when the file names a list it did not carry', async () => {
    const task = await store.createTask({ title: 'Orphan', listId: (await store.createTaskList({ name: 'Work' })).id })
    const backup = await exportAssistant(store)
    // A file written by hand, or by a build that did not export lists.
    delete (backup.data as Record<string, unknown>).task_lists

    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    expect((await target.getTask(task.id))?.listId).toBeNull()
  })

  it('lets the reminder fire again on the machine that received the file', async () => {
    const due = Date.parse('2026-10-20T09:00:00Z')
    const task = await store.createTask({ title: 'Call', dueAt: due, reminders: [due] })
    // It has already gone out here. A restore is not a delivery, so a fired row is left behind rather
    // than re-queued: nothing about it travels, and the account that receives the file gets no alarm.
    sqlite.prepare('UPDATE todos_reminders SET fired_at = ?1 WHERE user_id = ?2 AND task_id = ?3')
      .run(due, USER, task.id)

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    expect((await target.getTask(task.id))?.reminders).toEqual([])
    expect((await target.getTask(task.id))?.remindedAt).toBeNull()
    expect(pendingReminderCount(OTHER)).toBe(0)
  })

  it('carries no reminder column in the task rows', async () => {
    // `todos_reminders` superseded both columns, and a file that still named them would be a file whose
    // reminder nothing reads: the keys are the list, or the one number an older build wrote.
    await store.createTask({ title: 'Plain', reminders: [Date.parse('2026-10-20T09:00:00Z')] })
    const exported = await store.exportTables()
    const row = exported.tasks[0]!

    expect(Object.keys(row)).not.toContain('remind_at')
    expect(Object.keys(row)).not.toContain('reminded_at')
    expect(row.reminders).toHaveLength(1)
  })

  it('does not bring a task back over a newer local copy', async () => {
    const task = await store.createTask({ title: 'Original' })
    const backup = await exportAssistant(store)
    await store.updateTask(task.id, { title: 'Renamed here' })

    await importAssistant(store, JSON.parse(JSON.stringify(backup)))

    expect((await store.getTask(task.id))?.title).toBe('Renamed here')
  })

  it('carries every pending reminder of a task, not only the first', async () => {
    // The file used to hold one instant per task, so a reader who set five got one back and had no way
    // to tell the other four had been thrown away.
    const due = Date.parse('2026-10-20T09:00:00Z')
    const times = [-3_600_000, -900_000, -600_000, 600_000, 3_600_000].map((offset) => due + offset)
    const task = await store.createTask({ title: 'Five chances', dueAt: due, reminders: times })
    expect((await store.getTask(task.id))?.reminders).toHaveLength(5)

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    expect((await target.getTask(task.id))?.reminders).toEqual(times)
  })

  it('still imports a file that names one reminder on the task row', async () => {
    // Deprecation window: every file written before the `reminders` array carried a single `remind_at`
    // number. The reader who restores one of those gets the reminder they set, not silence.
    const due = Date.parse('2026-10-20T09:00:00Z')
    const task = await store.createTask({ title: 'Written by an older build', dueAt: due, reminders: [due - 60_000] })
    const backup = JSON.parse(JSON.stringify(await exportAssistant(store))) as { data: Record<string, unknown> }
    const row = (backup.data.tasks as Record<string, unknown>[]).find((entry) => entry.id === task.id)!
    delete row.reminders
    row.remind_at = due - 60_000

    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, backup)

    expect((await target.getTask(task.id))?.reminders).toEqual([due - 60_000])
  })

  it('restores a task\'s attachment links so its files still resolve', async () => {
    // The bytes live in the file hub and travel in no backup; what was lost was the link that says
    // which file the task shows, so a restored task came back with an empty attachment list.
    const task = await store.createTask({ title: 'Signed contract' })
    const attachmentId = newId()
    sqlite.prepare(
      `INSERT INTO attachments (id, user_id, scope, filename, mime, size, sha256, storage, created_at)
       VALUES (?1, ?2, 'todos', 'contract.pdf', 'application/pdf', 12, 'hash', 'r2', 1)`,
    ).run(attachmentId, USER)
    expect(await linkTodoAttachment(env.DB as D1Database, USER, task.id, attachmentId, Date.now())).toBe(true)

    const backup = await exportAssistant(store)
    // The device that lost its link table but kept its files: the case a restore is actually for.
    sqlite.exec('DELETE FROM todos_attachments')
    expect(await listTodoAttachments(env.DB as D1Database, USER, task.id)).toEqual([])

    await importAssistant(store, JSON.parse(JSON.stringify(backup)))

    const restored = await listTodoAttachments(env.DB as D1Database, USER, task.id)
    expect(restored.map((row) => [row.id, row.filename])).toEqual([[attachmentId, 'contract.pdf']])
  })

  it('keeps credentials and the replayed history out of the file', async () => {
    // A feed slug with its password hash and a mail token are the capability itself, so they go
    // nowhere near an export; the event table is left out for the size reason the plan measured.
    sqlite.prepare(
      `INSERT INTO todos_feeds (slug, user_id, password_hash, created_at) VALUES ('s1', ?1, 'hash', 1)`,
    ).run(USER)
    sqlite.prepare(`INSERT INTO todos_mail_tokens (user_id, token, created_at) VALUES (?1, 'tok', 1)`).run(USER)
    await store.createTask({ title: 'One task' })
    // The three tables are each holding a row, so the exclusions below are about the export and not
    // about an empty database.
    for (const table of ['todos_feeds', 'todos_mail_tokens', 'todos_task_events']) {
      expect(Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)).toBeGreaterThan(0)
    }

    const exported = await store.exportTables()

    expect(Object.keys(exported).filter((key) => /feed|mail|token|event/i.test(key))).toEqual([])
    const text = JSON.stringify(exported)
    expect(text).not.toContain('hash')
    expect(text).not.toContain('tok')
  })

  it('says on the restore summary what no backup could carry', async () => {
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await store.createTask({ title: 'One task' })

    const summary = await importAssistant(target, JSON.parse(JSON.stringify(await exportAssistant(store))))

    const notes = summary.skipped.join('\n')
    expect(notes).toMatch(/calendar feed/i)
    expect(notes).toMatch(/mail/i)
    expect(notes).toMatch(/flow/i)
  })
})

/**
 * The habits travel with their days, and nothing else.
 *
 * §4.5's second channel is the one a new table fails quietly: an export that names a column the import
 * allowlist does not accept, or a day whose habit never landed, produces a restore that looks complete
 * and is not. Both halves are measured here against the database, because `INSERT OR IGNORE` never
 * complains — and the size of the pair is measured too, since this deployment's ceiling is four megabytes
 * and a ten-thousand-task account is already at five.
 */
describe('a habit round trip', () => {
  /** The days one account holds for one habit, read where they live. */
  function habitDays(userId: string, counterId: string): { day: string, amount: number }[] {
    return sqlite.prepare(
      `SELECT day, amount FROM todos_counter_ticks WHERE user_id = ?1 AND counter_id = ?2 ORDER BY day ASC`,
    ).all(userId, counterId) as { day: string, amount: number }[]
  }

  function habitRowCount(userId: string): number {
    return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM todos_counters WHERE user_id = ?1`)
      .get(userId) as { n: number | bigint }).n)
  }

  /** Writes the account's file back into a second one, the way the restore route does. */
  async function restore(): Promise<void> {
    await importAssistant(new AssistantStore(env.DB as D1Database, OTHER, env), JSON.parse(JSON.stringify(await exportAssistant(store))))
  }

  it('restores the habit, its days, and the difference between no target and a target of none', async () => {
    const counted = await createCounter(env.DB as D1Database, USER, { title: 'Water', kind: 'clicks', goal: 8, icon: '💧', color: '#2563eb' })
    const openEnded = await createCounter(env.DB as D1Database, USER, { title: 'Breath', kind: 'clicks', goal: null })
    if (!counted || !openEnded) throw new Error('The habits were not created.')
    await addCounterTick(env.DB as D1Database, USER, counted.id, '2026-10-20', 3)
    await addCounterTick(env.DB as D1Database, USER, counted.id, '2026-10-21', 8)
    await addCounterTick(env.DB as D1Database, USER, openEnded.id, '2026-10-21', 1)

    await restore()
    const restored = new Map((await listCounters(env.DB as D1Database, OTHER)).map((habit) => [habit.title, habit]))
    // Read by title, not by position: the listing is stable at `(created_at, id)`, and two habits made in
    // the same millisecond are ordered by their random tails.
    expect([...restored.keys()].sort()).toEqual(['Breath', 'Water'])
    expect(restored.get('Water')).toMatchObject({ kind: 'clicks', goal: 8, icon: '💧', color: '#2563eb' })
    expect(restored.get('Breath')?.goal).toBeNull()
    expect(String(restored.get('Breath')?.color)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(habitDays(OTHER, counted.id)).toEqual([{ day: '2026-10-20', amount: 3 }, { day: '2026-10-21', amount: 8 }])
    expect(habitDays(OTHER, openEnded.id)).toEqual([{ day: '2026-10-21', amount: 1 }])
  })

  it('restores a habit stopped, never running', async () => {
    const running = await createCounter(env.DB as D1Database, USER, { title: 'Meditate', kind: 'stopwatch' })
    if (!running) throw new Error('The habit was not created.')
    await startCounterTimer(env.DB as D1Database, USER, running.id, Date.parse('2026-10-21T08:00:00Z'))
    expect((await getCounter(env.DB as D1Database, USER, running.id))?.runningSince).not.toBeNull()

    await restore()
    const restored = (await listCounters(env.DB as D1Database, OTHER)).find((habit) => habit.id === running.id)
    expect(restored?.kind).toBe('stopwatch')
    // The file says nothing about a run at all — the key is dropped on the way out, so no restore is ever
    // handed a stopwatch it did not start — and the habit that comes back is at rest.
    const file = JSON.parse(JSON.stringify(await exportAssistant(store))) as { data: Record<string, Record<string, unknown>[]> }
    expect(file.data.counters.some((entry) => 'running_since' in entry)).toBe(false)
    expect(restored?.runningSince).toBeNull()
    expect(habitDays(OTHER, running.id)).toEqual([])
  })

  it('drops a day whose habit the file does not carry', async () => {
    const kept = await createCounter(env.DB as D1Database, USER, { title: 'Walk', kind: 'clicks' })
    const removed = await createCounter(env.DB as D1Database, USER, { title: 'Prune', kind: 'clicks' })
    if (!kept || !removed) throw new Error('The habits were not created.')
    await addCounterTick(env.DB as D1Database, USER, kept.id, '2026-10-20', 1)
    await addCounterTick(env.DB as D1Database, USER, removed.id, '2026-10-20', 4)

    const file = JSON.parse(JSON.stringify(await exportAssistant(store))) as { data: Record<string, unknown[]> }
    file.data.counters = file.data.counters.filter((entry) => (entry as { id: string }).id !== removed.id)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, file)

    expect(habitRowCount(OTHER)).toBe(1)
    expect(habitDays(OTHER, kept.id)).toEqual([{ day: '2026-10-20', amount: 1 }])
    // The orphan is the whole point: a row no habit can name is unreachable by every screen and every
    // later delete, so the restore that kept it would be writing the leak into the new account.
    expect(habitDays(OTHER, removed.id)).toEqual([])
  })

  it('does not count a tap twice when one file is restored twice', async () => {
    const habit = await createCounter(env.DB as D1Database, USER, { title: 'Read', kind: 'clicks' })
    if (!habit) throw new Error('The habit was not created.')
    await addCounterTick(env.DB as D1Database, USER, habit.id, '2026-10-20', 2)
    const backup = JSON.parse(JSON.stringify(await exportAssistant(store)))

    await importAssistant(new AssistantStore(env.DB as D1Database, OTHER, env), backup)
    await importAssistant(new AssistantStore(env.DB as D1Database, OTHER, env), backup)
    expect(habitDays(OTHER, habit.id)).toEqual([{ day: '2026-10-20', amount: 2 }])
  })

  it('refuses to invent a kind, a day shape, or an amount a day cannot hold', async () => {
    const file = {
      format: 'inkstone-assistant-backup',
      version: 1,
      exportedAt: Date.now(),
      data: {
        settings: {},
        counters: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Odd', kind: 'interval', goal: 1e9, created_at: 1, updated_at: 1 }],
        counter_ticks: [
          { counter_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', day: '2026-10-20', amount: 1e9 },
          { counter_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', day: '2026', amount: 5 },
          { counter_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', day: '2026-10-21', amount: -3 },
        ],
      },
    }
    await importAssistant(new AssistantStore(env.DB as D1Database, OTHER, env), file)

    const restored = (await listCounters(env.DB as D1Database, OTHER))[0]
    // An unknown word becomes the habit that needs no timer rather than a timer the restore invented.
    // Read from the column, not through the row reader: the reader folds an unknown kind too, and a test
    // that only asked it would pass while the file wrote the invention straight into the database.
    const storedKind = sqlite.prepare(`SELECT kind FROM todos_counters WHERE user_id = ?1 AND id = ?2`)
      .get(OTHER, 'aaaaaaaaaaaaaaaaaaaaaaaaaa') as { kind: string }
    expect(storedKind.kind).toBe('clicks')
    expect(restored?.kind).toBe('clicks')
    expect(restored?.goal).toBe(MAX_COUNTER_DAY_AMOUNT)
    // The oversized day is clamped into what a day holds, the half-written date never lands, and a
    // negative amount is not a record of anything.
    expect(habitDays(OTHER, 'aaaaaaaaaaaaaaaaaaaaaaaaaa')).toEqual([{ day: '2026-10-20', amount: MAX_COUNTER_DAY_AMOUNT }])
  })

  it('keeps a whole shelf of habits far below the ceiling a restore accepts', async () => {
    const days = eachDay(addDays('2026-10-23', -(COUNTER_WINDOW_DAYS - 1)), '2026-10-23')
    let written = 0
    for (let habit = 0; habit < MAX_COUNTERS_PER_ACCOUNT; habit++) {
      const id = `aaaa${String(habit).padStart(22, '0')}`
      sqlite.prepare(
        `INSERT INTO todos_counters (user_id, id, title, kind, goal, created_at, updated_at) VALUES (?, ?, ?, 'clicks', 8, 1, 1)`,
      ).run(USER, id, `Habit ${habit}`)
      written += 1
      for (const day of days) {
        sqlite.prepare(
          `INSERT INTO todos_counter_ticks (user_id, counter_id, day, amount) VALUES (?, ?, ?, 8)`,
        ).run(USER, id, day)
        written += 1
      }
    }
    // The fixture's own bookkeeping: a shelf this suite measures is worth nothing if it did not fill one.
    expect(written).toBe(MAX_COUNTERS_PER_ACCOUNT * COUNTER_WINDOW_DAYS + MAX_COUNTERS_PER_ACCOUNT)

    const file = JSON.parse(JSON.stringify(await exportAssistant(store))) as { data: Record<string, unknown[]> }
    const bytes = JSON.stringify(file.data.counters).length + JSON.stringify(file.data.counter_ticks).length
    const rows = file.data.counter_ticks.length
    expect(rows).toBe(MAX_COUNTERS_PER_ACCOUNT * COUNTER_WINDOW_DAYS)
    // Measured here, and recorded in the plan (§4.5's third channel): 1,426,392 bytes for a whole year of
    // every habit an account may hold — about 97 bytes a day-row. That is a third of the four-megabyte
    // ceiling a restore accepts, before a single task is in the file, which is why a tick row carries the
    // three columns the screen reads and nothing else: no stamp, no id of its own, no per-tap log. A
    // second year of days doubles the figure, and the history is what a streak is made of, so the file
    // keeps it whole rather than truncating a reader's longest run to what fits.
    expect(bytes).toBeLessThan(1_500_000)
    expect(bytes / rows).toBeLessThan(120)
  })
})

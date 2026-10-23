// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { exportAssistant, importAssistant } from '../src/worker/assistant/backup'
import { linkTodoAttachment, listTodoAttachments } from '../src/worker/todos/schema'
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

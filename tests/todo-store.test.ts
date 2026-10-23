// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { listTodoAttachments } from '../src/worker/todos/schema'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import { isTaskDone, isTaskOpen } from '../src/shared/todos/status'

const USER = 'user-alice'
const OTHER = 'user-bob'
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** Two files a task can show: the link table cares only that the rows are the account's own. */
const FILE_A = 'a'.repeat(26)
const FILE_B = 'b'.repeat(26)

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore

/** Seeds one file and the link that puts it on a task, the way the upload route leaves both. */
function linkFile(taskId: string, attachmentId: string): void {
  sqlite.prepare(
    `INSERT INTO attachments (id, user_id, scope, note_id, filename, mime, size, sha256, object_key, width, height, storage, created_at)
     VALUES (?, ?, 'todos', NULL, ?, 'text/plain', 4, ?, ?, NULL, NULL, 'r2', 1)`,
  ).run(attachmentId, USER, `${attachmentId}.txt`, `${attachmentId}hash`, `todos/${USER}/${attachmentId}.txt`)
  sqlite.prepare(
    'INSERT INTO todos_attachments (user_id, task_id, attachment_id, created_at) VALUES (?, ?, ?, 1)',
  ).run(USER, taskId, attachmentId)
}

async function fileIdsOf(taskId: string): Promise<string[]> {
  const rows = await listTodoAttachments(env.DB as D1Database, USER, taskId)
  return rows.map((row) => row.id).sort()
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
})

// Only the cases that count a cycle from "now" hold the clock still, and none of them leaves it held.
afterEach(() => {
  vi.useRealTimers()
})

describe('writing a task', () => {
  it('keeps the list, the tags and the steps it was created with', async () => {
    const list = await store.createTaskList({ name: 'Work', icon: 'Briefcase', color: '#2563eb' })
    const task = await store.createTask({
      title: '  File the return  ',
      listId: list.id,
      starred: true,
      tags: ['Tax', 'urgent'],
      steps: ['Collect receipts', 'Fill the form'],
      dueAt: Date.parse('2026-10-20T09:00:00Z'),
    })

    expect(task.title).toBe('File the return')
    expect(task.listId).toBe(list.id)
    expect(task.starred).toBe(true)
    expect(task.tags.map((tag) => tag.name)).toEqual(['Tax', 'urgent'])
    expect(task.stepTotal).toBe(2)
    expect(task.stepDone).toBe(0)

    const steps = await store.listSteps(task.id)
    expect(steps.map((step) => step.text)).toEqual(['Collect receipts', 'Fill the form'])
    expect(steps.every((step) => !step.done)).toBe(true)
  })

  it('does not clear the columns a patch did not name', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const task = await store.createTask({
      title: 'One', listId: list.id, starred: true, tags: ['Tax'], repeat: { freq: 'weekly', interval: 1 },
    })

    const updated = await store.updateTask(task.id, { priority: 'urgent' })

    expect(updated).toMatchObject({ priority: 'urgent', listId: list.id, starred: true })
    expect(updated?.tags.map((tag) => tag.name)).toEqual(['Tax'])
    expect(updated?.repeat).toEqual({ freq: 'weekly', interval: 1 })
  })

  it('moves a reminder with its due date', async () => {
    const due = Date.parse('2026-10-20T09:00:00Z')
    const task = await store.createTask({ title: 'Call', dueAt: due, remindAt: due - HOUR })

    const moved = await store.updateTask(task.id, { dueAt: due + DAY })

    expect(moved?.remindAt).toBe(due + DAY - HOUR)
    expect(moved?.remindedAt).toBeNull()
  })

  it('replaces tags and reuses one that already exists, whatever its case', async () => {
    const first = await store.createTask({ title: 'A', tags: ['Work'] })
    const second = await store.createTask({ title: 'B', tags: ['work', 'Life'] })

    const tags = await store.listTaskTags()
    expect(tags.map((tag) => tag.name).sort()).toEqual(['Life', 'Work'])
    expect(second.tags.map((tag) => tag.id)).toContain(first.tags[0]!.id)

    const cleared = await store.updateTask(second.id, { tags: [] })
    expect(cleared?.tags).toEqual([])
  })
})

describe("a task's own face", () => {
  it('keeps the icon and colour it was created with', async () => {
    const task = await store.createTask({ title: 'One', icon: 'lucide:Star', color: '#dc2626' })
    expect(task.icon).toBe('lucide:Star')
    expect(task.color).toBe('#dc2626')
    expect(await store.getTask(task.id)).toMatchObject({ icon: 'lucide:Star', color: '#dc2626' })
  })

  it('leaves both null while the task wears its list’s', async () => {
    const task = await store.createTask({ title: 'One' })
    expect(task.icon).toBeNull()
    expect(task.color).toBeNull()
  })

  it('refuses an unusable icon or colour rather than storing it', async () => {
    const task = await store.createTask({ title: 'One', icon: 'x'.repeat(41), color: 'red' })
    expect(task.icon).toBeNull()
    expect(task.color).toBeNull()
  })

  it('sets a face through a patch, and clears it again with an explicit null', async () => {
    const task = await store.createTask({ title: 'One' })

    const faced = await store.updateTask(task.id, { icon: 'lucide:Star', color: '#dc2626' })
    expect(faced).toMatchObject({ icon: 'lucide:Star', color: '#dc2626' })

    const cleared = await store.updateTask(task.id, { icon: null, color: null })
    expect(cleared?.icon).toBeNull()
    expect(cleared?.color).toBeNull()
  })

  it('leaves the face standing when a patch names neither column', async () => {
    const task = await store.createTask({ title: 'One', icon: 'lucide:Star' })
    const renamed = await store.updateTask(task.id, { title: 'Two' })
    expect(renamed).toMatchObject({ title: 'Two', icon: 'lucide:Star', color: null })
  })
})

describe('lists', () => {
  it('answers a duplicate name with the list that already has it', async () => {
    const first = await store.createTaskList({ name: 'Work' })
    const again = await store.createTaskList({ name: ' work ' })
    expect(again.id).toBe(first.id)
    expect(await store.listTaskLists()).toHaveLength(1)
  })

  it('gives a new list a colour from the shared palette', async () => {
    const list = await store.createTaskList({ name: 'Errands' })
    expect(list.color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('moves a deleted list’s tasks to the inbox instead of deleting them', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const task = await store.createTask({ title: 'One', listId: list.id })

    await store.deleteTaskList(list.id)

    expect(await store.listTaskLists()).toHaveLength(0)
    expect((await store.getTask(task.id))?.listId).toBeNull()
  })
})

describe('the counts a sidebar and a card show', () => {
  it('reads every smart list from the same snapshot', async () => {
    const now = Date.now()
    const dayEnd = now + 6 * HOUR
    const list = await store.createTaskList({ name: 'Work' })
    await store.createTask({ title: 'Overdue', dueAt: now - 2 * DAY })
    await store.createTask({ title: 'Today', dueAt: now + HOUR })
    await store.createTask({ title: 'Upcoming', dueAt: now + 3 * DAY, listId: list.id })
    await store.createTask({ title: 'Someday' })
    await store.createTask({ title: 'Starred', starred: true, tags: ['Focus'] })
    const done = await store.createTask({ title: 'Done', listId: list.id, tags: ['Focus'] })
    // Finished through `completeTask`: the general patch now refuses a transition into `done`.
    await store.completeTask(done.id, 'UTC')

    const counts = await store.taskCounts(dayEnd)

    expect(counts).toMatchObject({ inbox: 4, today: 2, upcoming: 1, overdue: 1, all: 5, completed: 1, starred: 1 })
    expect(counts.byList[list.id]).toEqual({ open: 1, done: 1 })
    // A tag carries the same pair a list does: its view shows the finished rows too, and one number
    // could not be checked against either group in it.
    const tag = (await store.listTaskTags()).find((entry) => entry.name === 'Focus')!
    expect(counts.byTag[tag.id]).toEqual({ open: 1, done: 1 })
  })

  it('counts a started task as work the reader still owes in every badge at once', async () => {
    // Four started rows, placed so each one lands in a different badge: an undated row is today's by
    // being started, a late row is overdue and today's, a future row is upcoming and sits on a list
    // card, and a tagged row is the starred one. A badge that read `in_progress` as finished would
    // drop all four, and the `done` row is here so a badge that read it as finished cannot simply
    // answer zero everywhere and pass.
    const now = Date.now()
    const dayEnd = now + 6 * HOUR
    const list = await store.createTaskList({ name: 'Work' })
    await store.createTask({ title: 'Started undated', status: 'in_progress' })
    await store.createTask({ title: 'Started late', status: 'in_progress', dueAt: now - 2 * DAY, starred: true })
    await store.createTask({ title: 'Started ahead', status: 'in_progress', dueAt: now + 3 * DAY, listId: list.id, tags: ['Focus'] })
    await store.createTask({ title: 'Started today', status: 'in_progress', dueAt: now + HOUR, tags: ['Focus'] })
    const done = await store.createTask({ title: 'Done', listId: list.id, tags: ['Focus'] })
    await store.completeTask(done.id, 'UTC')

    const counts = await store.taskCounts(dayEnd)

    expect(counts).toMatchObject({ inbox: 3, today: 3, upcoming: 1, overdue: 1, all: 4, completed: 1, starred: 1 })
    expect(counts.byList[list.id]).toEqual({ open: 1, done: 1 })
    const tag = (await store.listTaskTags()).find((entry) => entry.name === 'Focus')!
    expect(counts.byTag[tag.id]).toEqual({ open: 2, done: 1 })

    // The same four rows are what the list, tag and collection screens count for themselves — the
    // `openCount` a sidebar row prints is read off the open set, not off "not finished".
    expect(tag.openCount).toBe(2)
    const started = await store.getTaskList(list.id)
    expect(started?.openCount).toBe(1)
    expect(started?.doneCount).toBe(1)
    expect((await store.listTaskLists()).find((entry) => entry.id === list.id)?.openCount).toBe(1)
  })

  it('reads a cancelled row as neither owed nor finished — the row and the count agree', async () => {
    // A `cancelled` row is written straight to the column here, the way a newer build or a hand-edited
    // database would leave it. The SQL counting side already excludes it from `open`, so a badge built
    // on those counts says the reader owes nothing. The row read has to answer the same way: a decoder
    // that clamped an unrecognized status back to `todo` would call this same row a debt, and one piece
    // of data would give two answers depending on which door you entered through.
    const list = await store.createTaskList({ name: 'Work' })
    const task = await store.createTask({ title: 'Abandoned', listId: list.id })
    sqlite.prepare(`UPDATE todos_tasks SET status = 'cancelled' WHERE id = ?`).run(task.id)

    const read = await store.getTask(task.id)
    expect(read).not.toBeNull()
    // Not owed: the row read agrees with the SQL open set.
    expect(isTaskOpen(read!.status)).toBe(false)
    // Not finished either: abandoning is not completing, so the done set must not claim it.
    expect(isTaskDone(read!.status)).toBe(false)

    const counts = await store.taskCounts(Date.now() + 6 * HOUR)
    expect(counts.byList[list.id]).toEqual({ open: 0, done: 0 })
  })
})

describe('completing a task', () => {
  it('leaves the finished row alone and returns the next occurrence', async () => {
    const due = Date.parse('2026-10-19T09:00:00Z')
    const task = await store.createTask({
      title: 'Weekly report',
      dueAt: due,
      remindAt: due - HOUR,
      repeat: { freq: 'weekly', interval: 1 },
      tags: ['Work'],
      steps: ['Collect numbers', 'Write summary'],
    })
    await store.updateStep(task.id, (await store.listSteps(task.id))[0]!.id, { done: true })

    const result = await store.completeTask(task.id, 'UTC')

    expect(result?.task.status).toBe('done')
    expect(result?.task.completedAt).not.toBeNull()
    expect(result?.next).toMatchObject({
      title: 'Weekly report',
      status: 'todo',
      dueAt: due + 7 * DAY,
      remindAt: due + 7 * DAY - HOUR,
      repeat: { freq: 'weekly', interval: 1 },
    })
    expect(result?.next?.tags.map((tag) => tag.name)).toEqual(['Work'])
    expect(result?.next?.stepTotal).toBe(2)
    expect(result?.next?.stepDone).toBe(0)
    expect(await store.getTask(task.id)).toMatchObject({ status: 'done' })
  })

  it('has no next occurrence for a task that does not repeat', async () => {
    const task = await store.createTask({ title: 'One off' })
    const result = await store.completeTask(task.id, 'UTC')
    expect(result?.next).toBeNull()
  })

  it('carries the face, the pick and the files the finished task had', async () => {
    const due = Date.parse('2026-10-19T09:00:00Z')
    const task = await store.createTask({
      title: 'Weekly review',
      dueAt: due,
      icon: 'lucide:Timer',
      color: '#2563eb',
      repeat: { freq: 'weekly', interval: 1 },
    })
    await store.planTask(task.id, '2026-10-19')
    linkFile(task.id, FILE_A)
    linkFile(task.id, FILE_B)

    const next = (await store.completeTask(task.id, 'UTC'))?.next

    // A copy that lost the icon the reader set wears its list's face instead, which is a different
    // task; the same goes for the colour. Both are the task's own, so both are the copy's own.
    expect(next).toMatchObject({ icon: 'lucide:Timer', color: '#2563eb' })
    // The pick travels as a pick for the new occurrence's own day, not for the day the finished row
    // was picked for: a copy wearing a date that has already passed sits in a My Day nobody reads.
    expect(next?.plannedFor).toBe('2026-10-26')
    // The files come along as links, not as copies of the bytes.
    expect(next ? await fileIdsOf(next.id) : []).toEqual([FILE_A, FILE_B])
    // A copy is not a move: the finished row still shows its own files.
    expect(await fileIdsOf(task.id)).toEqual([FILE_A, FILE_B])
  })

  it('files the next copy of an undated repeat undated, and the chain still advances', async () => {
    const task = await store.createTask({
      title: 'Someday, weekly',
      repeat: { freq: 'weekly', interval: 1 },
    })

    const result = await store.completeTask(task.id, 'UTC')

    // A task that was never owed on a day does not acquire one by being finished: the next copy is
    // filed undated, and so carries no reminder and no start, because both are distances from a due.
    expect(result?.next).toMatchObject({ dueAt: null, startAt: null })
    expect(result?.next?.reminders ?? []).toEqual([])
    // The copy still repeats, so ticking it off files the one after it: no due date is a blank
    // schedule, not a dead end.
    const again = await store.completeTask(result!.next!.id, 'UTC')
    expect(again?.next).not.toBeNull()
    expect(again?.next?.dueAt).toBeNull()
  })

  it('keeps a picked undated repeat picked, for the day its next cycle opens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T06:00:00Z'))
    const task = await store.createTask({
      title: 'Someday, weekly',
      repeat: { freq: 'weekly', interval: 1 },
    })
    await store.planTask(task.id, '2026-10-19')

    const next = (await store.completeTask(task.id, 'UTC'))?.next

    expect(next?.dueAt).toBeNull()
    expect(next?.plannedFor).toBe('2026-10-26')
  })

  it('is idempotent: completing a finished task does not clone it again', async () => {
    const task = await store.createTask({ title: 'Weekly', dueAt: Date.parse('2026-10-19T09:00:00Z'), repeat: { freq: 'weekly', interval: 1 } })
    await store.completeTask(task.id, 'UTC')
    const again = await store.completeTask(task.id, 'UTC')
    expect(again?.next).toBeNull()
    expect(await store.listTasks()).toHaveLength(2)
  })
})

describe('deleting a task', () => {
  it('hides it while keeping its steps and tag links for a restore', async () => {
    const task = await store.createTask({ title: 'One', tags: ['Work'], steps: ['Step'] })
    await store.deleteTask(task.id)

    expect(await store.getTask(task.id)).toBeNull()
    // The delete stamps the row rather than removing it, so the children stay with the task it can
    // bring back; only the reads hide the row.
    const steps = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_steps WHERE task_id = ?').get(task.id) as { n: number }
    const links = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_tag_links WHERE task_id = ?').get(task.id) as { n: number }
    expect(steps.n).toBe(1)
    expect(links.n).toBe(1)
    expect(await store.listTaskTags()).toHaveLength(1)
  })
})

describe('another account', () => {
  it('cannot see the first account’s tasks', async () => {
    const mine = await store.createTask({ title: 'Mine' })
    const other = new AssistantStore(env.DB as D1Database, OTHER, env)

    expect(await other.listTasks()).toEqual([])
    expect(await other.getTask(mine.id)).toBeNull()
    expect(await other.resolveTask('Mine')).toBeNull()
    expect(await other.updateTask(mine.id, { title: 'Stolen' })).toBeNull()
    expect(await other.taskCounts(Date.now())).toMatchObject({ all: 0 })
  })
})

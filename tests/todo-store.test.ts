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
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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
    await store.updateTask(done.id, { status: 'done' })

    const counts = await store.taskCounts(dayEnd)

    expect(counts).toMatchObject({ inbox: 4, today: 2, upcoming: 1, overdue: 1, all: 5, completed: 1, starred: 1 })
    expect(counts.byList[list.id]).toEqual({ open: 1, done: 1 })
    // A tag carries the same pair a list does: its view shows the finished rows too, and one number
    // could not be checked against either group in it.
    const tag = (await store.listTaskTags()).find((entry) => entry.name === 'Focus')!
    expect(counts.byTag[tag.id]).toEqual({ open: 1, done: 1 })
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

  it('is idempotent: completing a finished task does not clone it again', async () => {
    const task = await store.createTask({ title: 'Weekly', dueAt: Date.parse('2026-10-19T09:00:00Z'), repeat: { freq: 'weekly', interval: 1 } })
    await store.completeTask(task.id, 'UTC')
    const again = await store.completeTask(task.id, 'UTC')
    expect(again?.next).toBeNull()
    expect(await store.listTasks()).toHaveLength(2)
  })
})

describe('deleting a task', () => {
  it('takes its steps and tag links with it', async () => {
    const task = await store.createTask({ title: 'One', tags: ['Work'], steps: ['Step'] })
    await store.deleteTask(task.id)

    expect(await store.getTask(task.id)).toBeNull()
    const steps = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_steps WHERE task_id = ?').get(task.id) as { n: number }
    const links = sqlite.prepare('SELECT COUNT(*) AS n FROM todos_tag_links WHERE task_id = ?').get(task.id) as { n: number }
    expect(steps.n).toBe(0)
    expect(links.n).toBe(0)
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

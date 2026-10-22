// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { exportAssistant, importAssistant } from '../src/worker/assistant/backup'
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
    const task = await store.createTask({ title: 'Call', dueAt: due, remindAt: due })
    sqlite.prepare('UPDATE todos_tasks SET reminded_at = ? WHERE id = ?').run(due, task.id)

    const backup = await exportAssistant(store)
    const target = new AssistantStore(env.DB as D1Database, OTHER, env)
    await importAssistant(target, JSON.parse(JSON.stringify(backup)))

    expect((await target.getTask(task.id))?.remindedAt).toBeNull()
  })

  it('does not bring a task back over a newer local copy', async () => {
    const task = await store.createTask({ title: 'Original' })
    const backup = await exportAssistant(store)
    await store.updateTask(task.id, { title: 'Renamed here' })

    await importAssistant(store, JSON.parse(JSON.stringify(backup)))

    expect((await store.getTask(task.id))?.title).toBe('Renamed here')
  })
})

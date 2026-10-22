// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS, initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ApiError } from '../src/worker/lib/errors'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

/**
 * The task row's version, and the edit that must not land on a row somebody else already changed.
 *
 * `rev` starts at 1 and every write path moves it on by exactly one, so a caller that read a task can
 * name the revision it is editing: a stale name is refused with the repo's `ApiError` 409 and writes
 * nothing, rather than replacing an edit it never saw. The migration that adds the column has to give
 * every row written before it a first revision, and has to be safe to apply again.
 */

const USER = 'user-alice'
const OTHER = 'user-bob'

let sqlite: DatabaseSync
let env: Env
let store: AssistantStore
let other: AssistantStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), { PUBLIC_URL: 'http://localhost' })
  store = new AssistantStore(env.DB as D1Database, USER, env)
  other = new AssistantStore(env.DB as D1Database, OTHER, env)
})

describe('a task’s revision', () => {
  it('starts at 1, whatever the task was created with', async () => {
    const plain = await store.createTask({ title: 'Plain' })
    const decorated = await store.createTask({
      title: 'Decorated',
      tags: ['Work'],
      steps: ['Collect receipts'],
      remindAt: Date.now() + 60_000,
    })

    expect(plain.rev).toBe(1)
    expect(decorated.rev).toBe(1)
    // Creation is one write: its tags, steps and reminders are part of that first revision.
    expect((await store.getTask(decorated.id))?.rev).toBe(1)
  })

  it('moves on by one for every write path', async () => {
    const task = await store.createTask({ title: 'One' })

    const edited = await store.updateTask(task.id, { title: 'Two' })
    expect(edited?.rev).toBe(2)

    const tagged = await store.updateTask(task.id, { tags: ['Work'] })
    expect(tagged?.rev).toBe(3)

    const planned = await store.planTask(task.id, '2026-10-20')
    expect(planned?.rev).toBe(4)

    await store.setTaskTags(task.id, ['Work', 'Urgent'])
    expect((await store.getTask(task.id))?.rev).toBe(5)

    const completed = await store.completeTask(task.id, 'UTC')
    expect(completed?.task.rev).toBe(6)

    const snoozed = await store.snoozeTask(task.id, Date.now() + 60_000)
    expect(snoozed?.rev).toBe(7)
  })

  it('moves on when a list or a project lets go of the task', async () => {
    const list = await store.createTaskList({ name: 'Work' })
    const task = await store.createTask({ title: 'One', listId: list.id })

    await store.deleteTaskList(list.id)

    expect((await store.getTask(task.id))?.rev).toBe(2)
  })
})

describe('a guarded edit', () => {
  it('lands when the revision still matches', async () => {
    const task = await store.createTask({ title: 'One' })

    const edited = await store.updateTask(task.id, { title: 'Two' }, undefined, 1)

    expect(edited?.title).toBe('Two')
    expect(edited?.rev).toBe(2)
  })

  it('refuses a stale revision with the repo’s 409 and writes nothing', async () => {
    const task = await store.createTask({ title: 'Original' })
    await store.updateTask(task.id, { title: 'Fresh' })
    const before = await store.getTask(task.id)

    const caught = await store.updateTask(
      task.id,
      { title: 'Stale', description: 'should not land', tags: ['Ghost'] },
      undefined,
      1,
    ).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(ApiError)
    expect(caught).toMatchObject({ status: 409, code: 'conflict', details: { id: task.id, rev: 2 } })
    expect(await store.getTask(task.id)).toEqual(before)
    // The tag the stale patch named was never created either: the refusal is before any write.
    expect(await store.listTaskTags()).toEqual([])
  })

  it('lets only one of two edits holding the same revision through', async () => {
    const task = await store.createTask({ title: 'Original' })

    const settled = await Promise.allSettled([
      store.updateTask(task.id, { title: 'First' }, undefined, 1),
      store.updateTask(task.id, { title: 'Second' }, undefined, 1),
    ])
    const won = settled.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.updateTask>>> =>
      result.status === 'fulfilled')
    const lost = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toMatchObject({ status: 409, code: 'conflict' })
    const final = await store.getTask(task.id)
    expect(final?.rev).toBe(2)
    expect(final?.title).toBe(won[0]!.value?.title)
  })

  it('never reaches another account’s task', async () => {
    const mine = await store.createTask({ title: 'Mine' })
    const theirs = await other.createTask({ title: 'Theirs' })

    await store.updateTask(mine.id, { title: 'Mine, edited' })

    expect((await other.getTask(theirs.id))?.rev).toBe(1)
    expect(await store.updateTask(theirs.id, { title: 'Hijacked' }, undefined, 1)).toBeNull()
    expect((await other.getTask(theirs.id))?.title).toBe('Theirs')
    expect((await other.getTask(theirs.id))?.rev).toBe(1)
  })
})

describe('the migration that adds the column', () => {
  function columnsOf(sqlite: DatabaseSync): string[] {
    return sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all('todos_tasks')
      .map((row) => (row as { name: string }).name)
  }

  function appliedCount(sqlite: DatabaseSync): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 136`).get() as { n: number }).n
  }

  function revOf(sqlite: DatabaseSync): number {
    return (sqlite.prepare(`SELECT rev FROM todos_tasks WHERE user_id = ?`).get(USER) as { rev: number }).rev
  }

  async function boot(target: DatabaseSync): Promise<void> {
    await initializeDatabase(testBindings(makeD1(target)))
  }

  /** The shape a deploy from before 136 lands on: the column gone, its ledger entry with it. */
  async function databaseBeforeRev(): Promise<DatabaseSync> {
    const target = new DatabaseSync(':memory:')
    target.exec('PRAGMA journal_mode = OFF')
    await boot(target)
    target.exec('ALTER TABLE todos_tasks DROP COLUMN rev')
    target.exec('DELETE FROM schema_migrations WHERE version = 136')
    target.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)
    target.prepare(
      `INSERT INTO todos_tasks (user_id, id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(USER, 'kept-task', 'Kept', 1, 1)
    return target
  }

  it('gives every row written before it a first revision', async () => {
    const target = await databaseBeforeRev()

    await boot(target)

    expect(columnsOf(target)).toContain('rev')
    expect(revOf(target)).toBe(1)
    expect(appliedCount(target)).toBe(1)
  })

  it('can be applied a second time without touching a revision it already moved', async () => {
    const target = await databaseBeforeRev()
    await boot(target)
    target.exec(`UPDATE todos_tasks SET rev = 7`)
    // A ledger that lost the number is exactly the case the column guard exists for.
    target.exec(`DELETE FROM schema_migrations WHERE version = 136`)
    target.exec(`DELETE FROM app_meta WHERE key LIKE 'database-state%'`)

    await boot(target)

    expect(revOf(target)).toBe(7)
    expect(appliedCount(target)).toBe(1)
  })
})

// @vitest-environment jsdom
/**
 * The adapter that turns one quick-add line into a task.
 *
 * The parse itself belongs to the board's `quickAddDraft` and is tested there; what this file pins is
 * the part the capture engine relies on: the title decides whether there is a task at all, and the
 * store's own `createTask` is the writer — no second request path, no note, no optimistic row of its
 * own. The store is replaced for the run so the case does not need a server.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useTodos, type TaskDraft } from '../../features/todos/store'
import type { TodoTask } from '@shared/todos/model'
import { createTodoFromQuickAdd } from './todo-sink'

const calls: TaskDraft[] = []

beforeEach(() => {
  calls.length = 0
  useTodos.setState({
    timezone: 'UTC',
    lists: [],
    createTask: async (input) => {
      calls.push(input)
      return { id: 'todo-1', title: input.title ?? '', status: 'todo' } as unknown as TodoTask
    },
  })
})

describe('filing a quick-add line as a task', () => {
  it('writes the parsed line through the store’s own createTask', async () => {
    const created = await createTodoFromQuickAdd('Buy milk')

    expect(created).toEqual({ id: 'todo-1', title: 'Buy milk' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ title: 'Buy milk' })
  })

  it('answers null for a line with no title, and writes nothing', async () => {
    expect(await createTodoFromQuickAdd('   ')).toBeNull()
    expect(calls).toEqual([])
  })
})

// @vitest-environment jsdom
/**
 * The row at the other end of a dependency is restated where it lives.
 *
 * `blocks` is the inverse of `dependsOn`, and neither server answer carries it: a save speaks for the
 * row it was made against. Left alone, the listing would keep showing a blocker with nothing waiting on
 * it until the next page read — the chip would disagree with the edge the reader just drew. So the store
 * re-reads the partners, through the same door the time ledger uses, and the cases below watch that read
 * happen: for the set being added, for the set being dropped, for neither when a save names no edges,
 * and for nobody at all when a partner is not on the page a reader is looking at.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { useUi } from '../../store/ui'
import type { TaskRef, TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  rows: new Map<string, TodoTask>(),
  /** The ids the store re-read, in order — the restatement is the thing being pinned. */
  gets: [] as string[],
  creates: [] as Record<string, unknown>[],
  updates: [] as { id: string, body: Record<string, unknown> }[],
}))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

function ref(id: string): TaskRef {
  const row = service.rows.get(id)!
  return { id, title: row.title, status: row.status }
}

/** The server's own restatement: both ends of every named edge, written onto both rows. */
function restateEdges(taskId: string, wanted: string[]): void {
  for (const row of service.rows.values()) {
    row.blocks = row.blocks.filter((entry) => entry.id !== taskId || wanted.includes(entry.id))
  }
  service.rows.get(taskId)!.dependsOn = wanted.map(ref)
  for (const id of wanted) service.rows.get(id)!.blocks = [ref(taskId)]
}

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [...service.rows.values()], total: service.rows.size, counts: EMPTY_COUNTS, dayEnd: 0, timezone: 'UTC' }),
      counts: async () => ({ counts: EMPTY_COUNTS, dayEnd: 0, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => {
        service.gets.push(id)
        return { task: service.rows.get(id)!, steps: [] }
      },
      create: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        const id = `c${service.creates.length}`
        service.rows.set(id, row(id, String(body.title ?? ''), { dependsOn: [], blocks: [] }))
        restateEdges(id, Array.isArray(body.dependsOn) ? body.dependsOn as string[] : [])
        return { task: service.rows.get(id)! }
      },
      update: async (id: string, body: Record<string, unknown>) => {
        service.updates.push({ id, body })
        const current = service.rows.get(id)!
        service.rows.set(id, { ...current, ...(body as Partial<TodoTask>) })
        if ('dependsOn' in body) restateEdges(id, body.dependsOn as string[])
        return { task: service.rows.get(id)! }
      },
    },
  },
}))

import { useTodos } from './store'

const original = useTodos.getState()

function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id, title, description: '', status: 'todo', priority: 'medium', dueAt: null, remindAt: null,
    remindedAt: null, plannedFor: null, completedAt: null, createdAt: 0, updatedAt: 0, listId: null,
    tags: [], dependsOn: [], blocks: [], starred: false, repeat: null, noteId: null, conversationId: null,
    projectId: null, stepTotal: 0, stepDone: 0, ...extra,
  }
}

function hydrate(tasks: TodoTask[]): void {
  for (const task of tasks) service.rows.set(task.id, task)
  useTodos.setState({ status: 'ready', tasks, completed: [], total: tasks.length, counts: null })
}

function cached(id: string): TodoTask {
  return useTodos.getState().tasks.find((entry) => entry.id === id)!
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.rows.clear()
  service.gets.length = 0
  service.creates.length = 0
  service.updates.length = 0
  useUi.setState({ toasts: [] })
  useTodos.setState(original, true)
})

afterEach(() => {
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

describe('restating the other end on a save', () => {
  it('re-reads the row a new edge waits on, and its chip arrives with it', async () => {
    hydrate([row('a', '写报告'), row('b', '发出去')])

    await useTodos.getState().updateTask('b', { dependsOn: ['a'] })

    expect(service.gets).toEqual(['a'])
    expect(cached('a').blocks).toEqual([{ id: 'b', title: '发出去', status: 'todo' }])
  })

  it('re-reads the row an edge was dropped from, not only the one added', async () => {
    hydrate([row('a', '写报告'), row('b', '发出去')])
    restateEdges('b', ['a'])

    await useTodos.getState().updateTask('b', { dependsOn: [] })

    expect(service.gets).toEqual(['a'])
    expect(cached('a').blocks).toEqual([])
  })

  it('re-reads both when a save swaps one blocker for another', async () => {
    hydrate([row('a', '旧前置'), row('b', '新前置'), row('t', '任务')])
    restateEdges('t', ['a'])

    await useTodos.getState().updateTask('t', { dependsOn: ['b'] })

    expect(service.gets.sort()).toEqual(['a', 'b'])
    expect(cached('a').blocks).toEqual([])
    expect(cached('b').blocks).toEqual([{ id: 't', title: '任务', status: 'todo' }])
  })

  it('reads nothing when the save names no edges at all', async () => {
    hydrate([row('a', '写报告'), row('b', '发出去')])

    await useTodos.getState().updateTask('b', { title: '改个名' })

    expect(service.gets).toEqual([])
  })

  it('re-reads the rows a create waits on', async () => {
    hydrate([row('a', '写报告')])

    await useTodos.getState().createTask({ title: '发出去', dependsOn: ['a'] })

    expect(service.gets).toEqual(['a'])
    expect(cached('a').blocks).toHaveLength(1)
  })

  it('leaves a partner nobody is showing to the next listing read', async () => {
    // `a` is the account's task — the route answers for it — but it is not on this page.
    service.rows.set('a', row('a', '写报告'))
    hydrate([row('b', '发出去')])

    await useTodos.getState().updateTask('b', { dependsOn: ['a'] })

    expect(service.gets).toEqual([])
  })
})


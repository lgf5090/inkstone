// @vitest-environment jsdom
/**
 * One step back, offered on the toast that announced the write.
 *
 * The undo is not a server endpoint: every case below watches the inverse writes the store sends
 * through the routes the app already has. A completed repeating task is the hard one — the server
 * filed the next occurrence when it finished the row, so taking the tick back has to delete that
 * occurrence before it reopens the original, and the call order is part of the contract.
 *
 * The toast is the window. The store refuses a step whose toast is gone, and a second write replaces
 * the first rather than growing a second undo button somewhere off screen.
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import type { TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  /** Every inverse and forward write, in the order the store made it. */
  updates: [] as { id: string, body: Record<string, unknown> }[],
  removes: [] as string[],
  creates: [] as Record<string, unknown>[],
  /** The occurrence the fake PATCH files when a repeating task is finished. */
  next: null as TodoTask | null,
  rows: new Map<string, TodoTask>(),
}))

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: EMPTY_COUNTS, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => {
        const task = service.rows.get(id)
        if (!task) throw new Error('not found')
        return { task, steps: [] }
      },
      update: async (id: string, body: Record<string, unknown>) => {
        service.updates.push({ id, body })
        const current = service.rows.get(id)
        if (!current) throw new Error('not found')
        const task = { ...current, ...(body as Partial<TodoTask>) }
        service.rows.set(id, task)
        const next = body.status === 'done' && current.repeat ? service.next : null
        if (next) service.rows.set(next.id, next)
        return next ? { task, next } : { task }
      },
      remove: async (id: string) => {
        service.removes.push(id)
        service.rows.delete(id)
        return { deleted: true as const }
      },
      create: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        const task = { ...row(`restored-${service.creates.length}`, String(body.title ?? '')), ...(body as Partial<TodoTask>) }
        service.rows.set(task.id, task)
        return { task }
      },
    },
  },
}))

import { Toaster } from '../../components/feedback'
import { useTodos } from './store'

const original = useTodos.getState()
let view: RenderedElement | null = null

/** A row the way the route serialises one. */
function row(id: string, title: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    remindedAt: null,
    plannedFor: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    starred: false,
    repeat: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
    ...extra,
  }
}

function hydrate(tasks: TodoTask[]): void {
  for (const task of tasks) service.rows.set(task.id, task)
  useTodos.setState({ status: 'ready', tasks, completed: [], total: tasks.length, counts: null })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.updates.length = 0
  service.removes.length = 0
  service.creates.length = 0
  service.next = null
  service.rows.clear()
  useUi.setState({ toasts: [] })
  useTodos.setState(original, true)
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

describe('undoing a completion', () => {
  it('deletes the occurrence the repeat filed before it reopens the row', async () => {
    const task = row('t1', 'Water the plants', { repeat: { freq: 'daily', interval: 1 } })
    service.next = row('t1-next', 'Water the plants', { dueAt: 1_800_000_000_000 })
    hydrate([task])

    await useTodos.getState().toggleTask(task)

    // The forward write is one PATCH, and the store shows the next occurrence it answered with.
    expect(service.updates).toEqual([{ id: 't1', body: { status: 'done' } }])
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['t1-next'])
    expect(useUi.getState().toasts.at(-1)?.action?.label).toBe(t('common.undo'))

    await useTodos.getState().undoLast()

    // The next occurrence goes first: reopening the series while its occurrence is still on the
    // shelf would leave a second row a reload would keep.
    expect(service.removes).toEqual(['t1-next'])
    expect(service.updates).toEqual([
      { id: 't1', body: { status: 'done' } },
      { id: 't1', body: { status: 'todo' } },
    ])
    expect(useTodos.getState().tasks.map((entry) => entry.id)).toEqual(['t1'])
    expect(useTodos.getState().tasks[0]?.status).toBe('todo')
    expect(useTodos.getState().undo).toBeNull()
  })

  it('offers the undo as a focusable button with an accessible name', async () => {
    const task = row('t1', 'Water the plants')
    hydrate([task])
    await useTodos.getState().toggleTask(task)

    view = renderElement(createElement(Toaster))
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((entry) => (entry.textContent ?? '').trim() === t('common.undo'))
    expect(button, 'the toast offered no undo button').toBeTruthy()
    button!.focus()
    expect(document.activeElement).toBe(button)
    // The window is stated rather than left to the default: six seconds, then the button is gone.
    expect(useUi.getState().toasts.at(-1)?.duration).toBe(6000)
  })
})

describe('undoing a move', () => {
  it('sends the row back to the list it came from', async () => {
    const task = row('t1', 'File the return', { listId: 'work' })
    hydrate([task])

    await useTodos.getState().updateTask('t1', { listId: 'home' })
    expect(useTodos.getState().tasks[0]?.listId).toBe('home')

    await useTodos.getState().undoLast()

    expect(service.updates).toEqual([
      { id: 't1', body: { listId: 'home' } },
      { id: 't1', body: { listId: 'work' } },
    ])
    expect(useTodos.getState().tasks[0]?.listId).toBe('work')
  })
})

describe('undoing a priority change', () => {
  it('sends the row back to the priority it had', async () => {
    const task = row('t1', 'File the return', { priority: 'high' })
    hydrate([task])

    await useTodos.getState().updateTask('t1', { priority: 'urgent' })
    expect(useTodos.getState().tasks[0]?.priority).toBe('urgent')

    await useTodos.getState().undoLast()

    expect(service.updates).toEqual([
      { id: 't1', body: { priority: 'urgent' } },
      { id: 't1', body: { priority: 'high' } },
    ])
    expect(useTodos.getState().tasks[0]?.priority).toBe('high')
  })
})

describe('the undo rail', () => {
  it('keeps only the latest step when two writes land', async () => {
    const first = row('a', 'First')
    const second = row('b', 'Second')
    hydrate([first, second])

    await useTodos.getState().toggleTask(first)
    await useTodos.getState().toggleTask(second)

    // The first toast is dismissed rather than left on screen with a button that would take back
    // the wrong write.
    expect(useUi.getState().toasts).toHaveLength(1)

    await useTodos.getState().undoLast()

    expect(service.updates).toEqual([
      { id: 'a', body: { status: 'done' } },
      { id: 'b', body: { status: 'done' } },
      { id: 'b', body: { status: 'todo' } },
    ])
    expect(useTodos.getState().completed.map((entry) => entry.id)).toEqual(['a'])
  })

  it('refuses a step once its toast has gone', async () => {
    const task = row('t1', 'Water the plants')
    hydrate([task])
    await useTodos.getState().toggleTask(task)

    const toast = useUi.getState().toasts.at(-1)
    expect(toast, 'the write was announced with no undo toast').toBeTruthy()
    useUi.getState().dismissToast(toast!.id)

    await useTodos.getState().undoLast()

    expect(service.updates, 'a step was taken after its window closed').toEqual([
      { id: 't1', body: { status: 'done' } },
    ])
    expect(useTodos.getState().undo).toBeNull()
  })
})

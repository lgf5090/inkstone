// @vitest-environment jsdom
/**
 * Multi-select and the batch bar.
 *
 * Selection is a mode a pointer enters and leaves: Command/Ctrl-click on a wide window, a long press on
 * a phone. The bar is what makes the mode legible — it names how many rows are picked and every action
 * it offers is the batch endpoint, once, with exactly those ids. The delete undo is checked here too,
 * because a batch is the one write whose inverse has to bring more than one row back from the trash.
 *
 * The store is stubbed at the API boundary, so every assertion below is about the request the client
 * actually made rather than about a fetch that never landed.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import { useUi } from '../../store/ui'
import type { TaskCounts, TaskList, TaskTag, TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  tasks: [] as TodoTask[],
  trashed: new Map<string, TodoTask>(),
  lists: [] as TaskList[],
  tags: [] as TaskTag[],
  /** Every batch request, in the order the client made it. */
  batches: [] as { ids: string[]; op: string; value?: unknown }[],
  restores: [] as string[],
  /** The occurrence a `complete` batch answers with, or null while the fake files none. */
  filed: null as TodoTask | null,
  /** Set to make the listing read fail, the way a connection that drops after a write does. */
  listFails: false,
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => {
        if (service.listFails) throw new Error('The connection went away')
        return {
          tasks: service.tasks,
          total: service.tasks.length,
          counts: {
            inbox: 0, today: 0, upcoming: 0, overdue: 0, all: service.tasks.length,
            completed: 0, starred: 0, byList: {}, byTag: {},
          } satisfies TaskCounts,
          dayEnd: Date.now() + 3_600_000,
          timezone: 'UTC',
        }
      },
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: service.tags }),
      get: async () => ({ task: null, steps: [] }),
      batch: async (body: { ids: string[]; op: string; value?: unknown }) => {
        service.batches.push(body)
        // The fake server applies the one operation this file exercises through the bar; a completion
        // leaves the row in place because the real route does too (it only changes status). A delete
        // stamps the row into the trash, where a restore can bring the same one back.
        if (body.op === 'delete') {
          for (const task of service.tasks.filter((entry) => body.ids.includes(entry.id))) {
            service.trashed.set(task.id, task)
          }
          service.tasks = service.tasks.filter((task) => !body.ids.includes(task.id))
        }
        // A completion answers with the occurrence the route filed, the same row the single-task PATCH
        // hands over; every other operation answers null beside its id.
        return {
          done: body.ids.map((id) => ({ id, next: body.op === 'complete' ? service.filed : null })),
          failed: [],
        }
      },
      restore: async (id: string) => {
        service.restores.push(id)
        const task = service.trashed.get(id)
        if (!task) throw new Error('not found')
        service.trashed.delete(id)
        service.tasks.push(task)
        return { task }
      },
    },
  },
}))

import { TodosApp } from './TodosApp'
import { useTodos } from './store'

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

function list(id: string, name: string): TaskList {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 }
}

function tag(id: string, name: string): TaskTag {
  return { id, name, color: null, createdAt: 0, updatedAt: 0, openCount: 0 }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  // The plan view draws every row through the same grouped list the other reading views use; the
  // board shows three per card, which would make the selection arithmetic about card contents.
  window.history.replaceState(null, '', '/todo?view=plan')
  await initI18n()
  service.tasks = [row('a', 'First'), row('b', 'Second')]
  service.trashed.clear()
  service.lists = [list('L1', 'Work')]
  service.tags = [tag('tag-1', 'Focus')]
  service.batches.length = 0
  service.restores.length = 0
  service.filed = null
  service.listFails = false
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

afterEach(() => {
  vi.useRealTimers()
  view?.unmount()
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  useUi.setState({ toasts: [] })
})

async function render(): Promise<void> {
  view = renderElement(createElement(TodosApp))
  // The listing, the lists and the tags land one after another before the view can draw its rows.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function titleButton(container: HTMLElement, title: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('[data-todo-open]')]
    .find((node) => (node.textContent ?? '').includes(title))
  if (!found) throw new Error(`no task row named ${title}`)
  return found
}

function batchBar(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="toolbar"][data-todo-batch-bar]')
}

function barButton(bar: HTMLElement, label: string): HTMLButtonElement {
  const found = [...bar.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!found) throw new Error(`the batch bar offers no ${label}`)
  return found
}

/** Let the batch call, its reload and its toast run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

describe('entering selection', () => {
  it('opens the bar on a Command/Ctrl-click and sends the ids it shows', async () => {
    stubBreakpoint(true)
    await render()
    expect(batchBar(view!.container), 'the bar is furniture until a row is picked').toBeNull()

    act(() => {
      titleButton(view!.container, 'First').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      )
    })

    const bar = batchBar(view!.container)
    expect(bar, 'the selection never reached the bar').not.toBeNull()
    // The bar is a named toolbar and says its count, which is what a screen reader reads on arrival.
    expect(bar!.getAttribute('aria-label')).toBe(t('todo.a11y.batch_bar'))
    expect(bar!.querySelector('[aria-live="polite"]')?.textContent).toContain('1')
    expect(bar!.textContent).toContain(t('todo.batch.selected', { count: 1 }))

    act(() => { barButton(bar!, t('todo.batch.complete')).click() })
    await settle()

    expect(service.batches).toEqual([{ ids: ['a'], op: 'complete' }])
    expect(batchBar(view!.container), 'the bar stayed after its work was done').toBeNull()
  })

  it('enters the mode from a long press on a phone', async () => {
    stubBreakpoint(false)
    await render()
    vi.useFakeTimers()

    act(() => {
      titleButton(view!.container, 'Second').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    act(() => { vi.advanceTimersByTime(600) })

    const bar = batchBar(view!.container)
    expect(bar, 'a long press did not enter selection').not.toBeNull()
    expect(bar!.querySelector('[aria-live="polite"]')?.textContent).toContain('1')
  })

  it('clears the mode with Escape without opening a task', async () => {
    stubBreakpoint(true)
    await render()
    act(() => {
      titleButton(view!.container, 'First').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      )
    })
    expect(batchBar(view!.container)).not.toBeNull()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(batchBar(view!.container)).toBeNull()
    expect(useTodos.getState().editorOpen).toBe(false)
  })
})

describe('the star the bar owes the picked rows', () => {
  it('sends a star batch for exactly the ids on screen', async () => {
    stubBreakpoint(true)
    await render()

    act(() => {
      titleButton(view!.container, 'First').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      )
      titleButton(view!.container, 'Second').dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }),
      )
    })

    const bar = batchBar(view!.container)
    expect(bar, 'the selection never reached the bar').not.toBeNull()
    act(() => { barButton(bar!, t('todo.task.star')).click() })
    await settle()

    // The route reads an explicit true rather than its own default, so the bar says which way it starred.
    expect(service.batches).toEqual([{ ids: ['a', 'b'], op: 'star', value: 'true' }])
  })
})

describe('a batch that deleted rows', () => {
  it('restores every deleted task when the reader takes the step back', async () => {
    service.tasks = [row('a', 'First', { listId: 'L1', tags: [tag('tag-1', 'Focus')] }), row('b', 'Second')]
    useTodos.setState({
      status: 'ready',
      tasks: service.tasks,
      total: 2,
      selectedIds: new Set(['a', 'b']),
    })

    const result = await useTodos.getState().batchTasks('delete')

    expect(result).toEqual({ done: [{ id: 'a', next: null }, { id: 'b', next: null }], failed: [] })
    expect(service.batches).toEqual([{ ids: ['a', 'b'], op: 'delete' }])
    // The request picks up both rows and the server's answer empties the page.
    expect(useTodos.getState().selectedIds.size).toBe(0)
    expect(useTodos.getState().tasks).toEqual([])
    expect(useUi.getState().toasts.at(-1)?.action?.label).toBe(t('todo.action.undo'))

    await useTodos.getState().undoLast()

    // One step back: both ids are restored, not re-created, and the rows keep their tags.
    expect(service.restores).toEqual(['a', 'b'])
    expect(useTodos.getState().tasks.map((task) => task.title).sort()).toEqual(['First', 'Second'])
    expect(useTodos.getState().tasks.find((task) => task.id === 'a')?.tags.map((entry) => entry.name)).toEqual(['Focus'])
  })
})

describe('a batch that completed repeating rows', () => {
  it('keeps the occurrence the answer carried when the reload cannot be read', async () => {
    const due = Date.parse('2026-10-21T02:00:00Z')
    const weekly = { freq: 'weekly' as const, interval: 1 }
    service.tasks = [row('a', 'Weekly report', { repeat: weekly, dueAt: due })]
    service.filed = row('b', 'Weekly report', { repeat: weekly, dueAt: due + 7 * 24 * 60 * 60 * 1000 })
    service.listFails = true
    useTodos.setState({
      status: 'ready', tasks: service.tasks, total: 1, selectedIds: new Set(['a']),
    })

    const result = await useTodos.getState().batchTasks('complete')

    expect(result?.done).toEqual([{ id: 'a', next: service.filed }])
    // The row the server made is on screen even though the page could not be re-read: the batch answer
    // named it, so a connection that drops in the gap does not hide the next occurrence.
    expect(useTodos.getState().tasks.map((task) => task.id)).toEqual(['a', 'b'])
  })
})

// @vitest-environment jsdom
/**
 * Multi-select and the batch bar.
 *
 * Selection is a mode a pointer enters and leaves: Command/Ctrl-click on a wide window, a long press on
 * a phone. The bar is what makes the mode legible — it names how many rows are picked and every action
 * it offers is the batch endpoint, once, with exactly those ids. The delete undo is checked here too,
 * because a batch is the one write whose inverse has to rebuild more than one row.
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
  lists: [] as TaskList[],
  tags: [] as TaskTag[],
  /** Every batch request, in the order the client made it. */
  batches: [] as { ids: string[]; op: string; value?: unknown }[],
  creates: [] as Record<string, unknown>[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: service.tasks,
        total: service.tasks.length,
        counts: {
          inbox: 0, today: 0, upcoming: 0, overdue: 0, all: service.tasks.length,
          completed: 0, starred: 0, byList: {}, byTag: {},
        } satisfies TaskCounts,
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: service.tags }),
      get: async () => ({ task: null, steps: [] }),
      batch: async (body: { ids: string[]; op: string; value?: unknown }) => {
        service.batches.push(body)
        // The fake server applies the one operation this file exercises through the bar; a completion
        // leaves the row in place because the real route does too (it only changes status).
        if (body.op === 'delete') service.tasks = service.tasks.filter((task) => !body.ids.includes(task.id))
        return { done: body.ids, failed: [] }
      },
      create: async (body: Record<string, unknown>) => {
        service.creates.push(body)
        const task = row(`restored-${service.creates.length}`, String(body.title ?? ''), body as Partial<TodoTask>)
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
  service.lists = [list('L1', 'Work')]
  service.tags = [tag('tag-1', 'Focus')]
  service.batches.length = 0
  service.creates.length = 0
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

describe('a batch that deleted rows', () => {
  it('recreates every deleted task when the reader takes the step back', async () => {
    useTodos.setState({
      status: 'ready',
      tasks: [row('a', 'First', { listId: 'L1', tags: [tag('tag-1', 'Focus')] }), row('b', 'Second')],
      total: 2,
      selectedIds: new Set(['a', 'b']),
    })

    const result = await useTodos.getState().batchTasks('delete')

    expect(result).toEqual({ done: ['a', 'b'], failed: [] })
    expect(service.batches).toEqual([{ ids: ['a', 'b'], op: 'delete' }])
    // The request picks up both rows and the server's answer empties the page.
    expect(useTodos.getState().selectedIds.size).toBe(0)
    expect(useTodos.getState().tasks).toEqual([])
    expect(useUi.getState().toasts.at(-1)?.action?.label).toBe(t('todo.action.undo'))

    await useTodos.getState().undoLast()

    // One step back, rebuilt wholesale: a batch undo is one entry on the single-step rail, not a stack.
    expect(service.creates.map((body) => body.title)).toEqual(['First', 'Second'])
    expect(service.creates[0]?.tags).toEqual(['Focus'])
    expect(useTodos.getState().tasks.map((task) => task.title).sort()).toEqual(['First', 'Second'])
  })
})

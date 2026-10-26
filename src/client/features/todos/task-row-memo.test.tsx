// @vitest-environment jsdom
/**
 * A row redraws when something it is drawn from moved, and not otherwise.
 *
 * Every write to the store replaces the whole `tasks` array, and the props a row is drawn from used to be
 * rebuilt with it — `{ dayEnd, now: Date.now() }` fresh at every render, and the two presses of every row
 * written out again at the call site — so a page of rows redrew on every keystroke in the filter, on the
 * minute the clock crossed, and on the write that touched the row beside the one the reader made (M-08).
 * `TaskRow` binds those presses inside a memo, and the page hands one actions object and one bounds
 * object down, so the comparison has something stable to answer from.
 *
 * What is counted is the card's own render pass, read off the menu list it builds for itself — exactly
 * one call per row per pass. A `memo` that never hits is indistinguishable from one that does unless the
 * passes are counted, so the cases name the numbers: three rows on the page, then none, then only the
 * row that changed.
 *
 * The last two cases are the price of the memo, and they are the ones worth being suspicious about. The
 * up and down of a manual order name the *open* rows beside this one, so a write that moves that set has
 * to reach every row — a stale neighbour is a drop that lands beside a task that has left the list. And
 * a row that reads the page-wide selection itself still paints as picked, memo or not.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

const painted = vi.hoisted(() => [] as string[])

vi.mock('./task-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task-menu')>()
  return {
    ...actual,
    // A card builds its own menu once per pass, so the row it built it for is the row that ran.
    buildTaskMenuItems: (
      task: Parameters<typeof actual.buildTaskMenuItems>[0],
      handlers: Parameters<typeof actual.buildTaskMenuItems>[1],
    ) => {
      painted.push(task.id)
      return actual.buildTaskMenuItems(task, handlers)
    },
  }
})

const service = vi.hoisted(() => ({ updates: [] as { id: string, patch: Record<string, unknown> }[] }))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: counts(), dayEnd: NOW + 86_400_000, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      update: async (id: string, patch: Record<string, unknown>) => {
        service.updates.push({ id, patch })
        return { task: { ...row(id), ...patch } as TodoTask, next: null }
      },
    },
  },
}))

import { BoardView } from './BoardView'
import { ListTaskView, StarredView } from './TaskViews'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-19T09:00:00Z')

function counts(): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
}

function row(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: `Task ${id}`,
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
    dependsOn: [],
    blocks: [],
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

const rows = (): TodoTask[] => [row('a'), row('b'), row('c')]
/** The same three rows with the middle one finished — the write a manual order cannot read off a stale page. */
const withBFinished = (): TodoTask[] => [row('a'), row('b', { status: 'done', completedAt: NOW }), row('c')]
let view: RenderedElement | null = null

function mountStarred(tasks: TodoTask[]): HTMLElement {
  useTodos.setState({ view: 'starred', tasks })
  view = renderElement(createElement(StarredView))
  return view.container
}

/** The list page, which is the surface that keeps its own manual order. */
function mountList(tasks: TodoTask[]): HTMLElement {
  useTodos.setState({ view: 'list', listId: 'inbox', sort: null, tasks })
  view = renderElement(createElement(ListTaskView))
  return view.container
}

function writeTasks(next: TodoTask[]): void {
  act(() => { useTodos.setState({ tasks: next }) })
}

function titleOf(container: HTMLElement, id: string): string {
  const title = container.querySelector(`[data-todo-open="${id}"]`)
  if (!title) throw new Error(`row ${id} drew no title`)
  return (title.textContent ?? '').trim()
}

/** The row's own body press, which is the way into the task rather than into its name. */
function pressBody(container: HTMLElement, id: string): void {
  const body = container.querySelector<HTMLButtonElement>(`[data-todo-details="${id}"]`)
  if (!body) throw new Error(`row ${id} drew no body`)
  act(() => { body.click() })
}

/** The star, whichever side of the hover it is on. */
async function pressStar(container: HTMLElement, id: string): Promise<void> {
  const title = t('todo.task.star')
  const star = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .find((node) => node.getAttribute('aria-label') === title && node.closest('article')?.querySelector(`[data-todo-details="${id}"]`))
  if (!star) throw new Error(`row ${id} drew no star`)
  await act(async () => {
    star.click()
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  painted.length = 0
  service.updates.length = 0
  useTodos.setState({
    status: 'ready',
    error: null,
    tasks: [] as TodoTask[],
    completed: [] as TodoTask[],
    lists: [],
    tags: [],
    counts: counts(),
    editorOpen: false,
    draft: null,
    selectedIds: new Set<string>(),
    query: '',
    dueFrom: null,
    dueTo: null,
    completedFrom: null,
    completedTo: null,
    view: 'starred',
    listId: null,
    tagId: null,
    sort: null,
    dayEnd: NOW + 86_400_000,
    timezone: 'UTC',
  })
  // The clock taken at every render is what used to break the memo, so the clock is held still.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  painted.length = 0
  vi.restoreAllMocks()
})

describe('the passes a page of rows makes', () => {
  it('draws every row once when the page arrives', () => {
    mountStarred(rows())
    expect(painted).toEqual(['a', 'b', 'c'])
  })

  it('redraws no row when the listing is re-read into the same rows', () => {
    const tasks = rows()
    mountStarred(tasks)
    painted.length = 0
    // A whole array replaced by the store, holding the very same rows: the page re-renders, and a row
    // has nothing new to draw.
    writeTasks([...tasks])
    expect(painted).toEqual([])
  })

  it('redraws no row when an unrelated part of the store moves', () => {
    mountStarred(rows())
    painted.length = 0
    act(() => {
      useTodos.setState({
        query: 'report',
        counts: { inbox: 4, today: 0, upcoming: 0, overdue: 0, all: 4, completed: 0, starred: 4, byList: {}, byTag: {} },
      })
    })
    expect(painted).toEqual([])
  })

  it('redraws only the row a write touched, and draws what it wrote', () => {
    const tasks = rows()
    const container = mountStarred(tasks)
    painted.length = 0
    writeTasks(tasks.map((task) => (task.id === 'b' ? { ...task, title: 'Task b renamed' } : task)))
    expect(painted).toEqual(['b'])
    expect(titleOf(container, 'b')).toBe('Task b renamed')
    expect(titleOf(container, 'a')).toBe('Task a')
  })

  it('redraws every row whose order a write moved', () => {
    const container = mountList(rows())
    expect(painted).toEqual(['a', 'b', 'c'])
    painted.length = 0
    // The up and down of a manual order name the open rows beside this one, so finishing a row moves
    // every other row's answer. A memo that kept the stale neighbours would place a drop beside a task
    // that has left the list, so this is the write that must reach all of them.
    writeTasks(withBFinished())
    expect([...painted].sort()).toEqual(['a', 'b', 'c'])
    expect(container.querySelectorAll('[data-todo-open]').length).toBe(3)
  })

  it('still opens and still stars the row the reader pressed', async () => {
    const container = mountStarred(rows())
    pressBody(container, 'b')
    expect(useTodos.getState().editorOpen).toBe(true)
    expect(useTodos.getState().draft?.id).toBe('b')
    // The star is the other press bound inside the memoised row, and it writes the row it was drawn for.
    await pressStar(container, 'a')
    expect(service.updates).toEqual([{ id: 'a', patch: { starred: true } }])
  })

  it('still paints a row the page-wide selection picked', () => {
    const container = mountStarred(rows())
    painted.length = 0
    // A tick is not a write to the row, and the rows read the mode themselves, so all three redraw for
    // the mode and the picked one is drawn as picked.
    act(() => { useTodos.setState({ selectedIds: new Set(['a']) }) })
    expect(painted).toEqual(['a', 'b', 'c'])
    const picked = container.querySelector<HTMLButtonElement>('[role="checkbox"]')
    expect(picked?.getAttribute('aria-checked')).toBe('true')
  })

  it('draws the board rows once each, and none of them again for a write that left them alone', () => {
    useTodos.setState({ view: 'board', tasks: rows(), lists: [] })
    view = renderElement(createElement(BoardView, { onOpenList: () => {} }))
    expect(painted).toEqual(['a', 'b', 'c'])
    painted.length = 0
    act(() => {
      useTodos.setState({
        query: 'report',
        counts: { inbox: 4, today: 0, upcoming: 0, overdue: 0, all: 4, completed: 0, starred: 0, byList: {}, byTag: {} },
      })
    })
    expect(painted).toEqual([])
  })
})


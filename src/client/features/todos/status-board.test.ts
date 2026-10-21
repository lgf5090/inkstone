// @vitest-environment jsdom
/**
 * One list read as three status columns.
 *
 * The split is a reading of rows the server already scoped and ordered: a column keeps the order the
 * page arrived in, and an empty column says so instead of leaving a strip that looks broken. The
 * arrangement lives in the address (`layout=columns`), so it is opened by a reload or a pasted link and
 * falls back to the ordinary list where three columns would not fit.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'

vi.mock('../../lib/api', () => {
  const counts = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
  return {
    api: {
      todos: {
        list: async () => ({ tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
      },
    },
  }
})

import { ListTaskView } from './TaskViews'
import { StatusBoard } from './status-board'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, status: TodoTask['status']): TodoTask {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: 'work',
    tags: [],
    starred: false,
    repeat: null,
    remindedAt: null,
    plannedFor: null,
    noteId: null,
    conversationId: null,
    projectId: null,
    stepTotal: 0,
    stepDone: 0,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    tasks: [],
    completed: [],
    lists: [],
    tags: [],
    counts: null,
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    view: 'list',
    listId: 'work',
    tagId: null,
    query: '',
    sort: null,
    dueFrom: null,
    dueTo: null,
    selectedId: null,
    selectedIds: new Set<string>(),
    editorOpen: false,
    draft: null,
    saving: false,
  })
  window.history.replaceState(null, '', '/todo')
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  window.history.replaceState(null, '', '/todo')
  vi.unstubAllGlobals()
})

function renderBoard(rows: TodoTask[]): void {
  view = renderElement(createElement(StatusBoard, { tasks: rows }))
}

function renderList(rows: TodoTask[]): void {
  useTodos.setState({ tasks: rows })
  view = renderElement(createElement(ListTaskView))
}

function column(status: TodoTask['status']): HTMLElement {
  const node = view!.container.querySelector<HTMLElement>(`[data-todo-status-column="${status}"]`)
  if (!node) throw new Error(`no ${status} column`)
  return node
}

/** The task ids a column holds, in the order they are drawn. */
function order(status: TodoTask['status']): string[] {
  return [...column(status).querySelectorAll<HTMLElement>('[data-todo-open]')]
    .map((node) => node.getAttribute('data-todo-open') ?? '')
}

describe('the status board', () => {
  it('splits one list into the three statuses, keeping the order the server sent', () => {
    renderBoard([task('a', 'in_progress'), task('b', 'todo'), task('c', 'done'), task('d', 'todo')])

    expect(order('todo')).toEqual(['b', 'd'])
    expect(order('in_progress')).toEqual(['a'])
    expect(order('done')).toEqual(['c'])
    // Each column is a real list of rows under its own heading, not a pile of divs.
    expect(column('todo').querySelector('h2')?.textContent).toContain(t('todo.status.todo'))
    expect(column('todo').querySelectorAll('ul > li')).toHaveLength(2)
    // The board is an arrangement of the page, not the page: printing never inherits one.
    expect(view!.container.querySelector('[data-todo-status-board]')?.getAttribute('data-print')).toBe('hide')
  })

  it('gives an empty column words instead of a blank strip', () => {
    renderBoard([task('a', 'todo')])

    expect(column('done').textContent).toContain(t('todo.board.empty_column'))
    expect(column('in_progress').textContent).toContain(t('todo.board.empty_column'))
  })
})

describe('the layout switch', () => {
  it('writes the chosen layout into the address and draws the columns', async () => {
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo?list=work')
    renderList([task('a', 'todo')])

    expect(view!.container.querySelector('[data-todo-status-board]')).toBeNull()
    const toggle = view!.container.querySelector<HTMLElement>('[data-todo-layout-toggle]')
    expect(toggle, 'a wide list has no way to ask for the columns').not.toBeNull()
    expect(toggle!.getAttribute('data-print')).toBe('hide')
    // The two options are finger-sized rather than the 22px a desktop menu row uses.
    expect(toggle!.querySelector('[role="radiogroup"]')?.className).toContain('[&_button]:min-h-11')

    const columns = [...toggle!.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((node) => (node.textContent ?? '').trim() === t('todo.layout.columns'))
    expect(columns).toBeDefined()
    await act(async () => {
      columns!.click()
      await Promise.resolve()
    })

    expect(window.location.search).toBe('?list=work&layout=columns')
    expect(view!.container.querySelector('[data-todo-status-board]')).not.toBeNull()
  })

  it('opens the columns a refreshed address names', () => {
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns')
    renderList([task('a', 'todo')])

    expect(view!.container.querySelector('[data-todo-status-board]')).not.toBeNull()
  })

  it('keeps the plain list when the same address opens on a narrow window', () => {
    stubBreakpoint(false)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns')
    renderList([task('a', 'todo')])

    expect(view!.container.querySelector('[data-todo-status-board]')).toBeNull()
    expect(view!.container.querySelector('[data-todo-layout-toggle]')).toBeNull()
    expect(view!.container.querySelector('[data-todo-open]')).not.toBeNull()
  })
})

// @vitest-environment jsdom
/**
 * What a parent is allowed to do to a row on screen.
 *
 * A parent gathers rows and says nothing about their status, so the tree's whole user-visible contract is
 * the gutter: an indent per level, a fold button only where there is something to fold, and a folded
 * parent that keeps its own place while its children leave the page. The arrangement is judged as a pure
 * function (it is the one place the order is decided) and the button as a real control with a real
 * accessible name — a `div` that swallows a press would pass the first and fail the second.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TodoTask } from '@shared/todos/model'
import { arrangeTree } from './task-groups'

const EMPTY_COUNTS = { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({ tasks: [], total: 0, counts: EMPTY_COUNTS, dayEnd: 0, timezone: 'UTC' }),
      counts: async () => ({ counts: EMPTY_COUNTS, dayEnd: 0, timezone: 'UTC' }),
      lists: async () => ({ lists: [] }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => ({ task: task(id), steps: [] }),
    },
  },
}))

import { ListTaskView } from './TaskViews'
import { useTodos } from './store'

function task(id: string, parentId: string | null = null, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id, title: `T-${id}`, description: '', status: 'todo', priority: 'medium', dueAt: null,
    remindAt: null, remindedAt: null, plannedFor: null, completedAt: null, createdAt: 1, updatedAt: 1,
    listId: null, parentId, projectId: null, tags: [], dependsOn: [], blocks: [], starred: false, repeat: null,
    noteId: null, conversationId: null, stepTotal: 0, stepDone: 0, ...extra,
  }
}

const ids = (rows: { task: TodoTask }[]): string[] => rows.map((row) => row.task.id)

describe('arranging a group as a tree', () => {
  it('puts each child directly under its own parent', () => {
    const rows = arrangeTree([task('a'), task('b', 'a'), task('c'), task('d', 'b')], new Set())
    expect(ids(rows)).toEqual(['a', 'b', 'd', 'c'])
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 0])
  })

  it('shows a child whose parent is not in this group at the top, not nowhere', () => {
    const rows = arrangeTree([task('x', 'somewhere-else')], new Set())
    expect(ids(rows)).toEqual(['x'])
    expect(rows[0]!.depth).toBe(0)
  })

  it('counts the children it holds and hides only a folded parent’s subtree', () => {
    const all = arrangeTree([task('p'), task('q', 'p'), task('r', 'p')], new Set())
    expect(all.find((row) => row.task.id === 'p')!.childCount).toBe(2)

    const folded = arrangeTree([task('p'), task('q', 'p'), task('r', 'p')], new Set(['p']))
    expect(ids(folded)).toEqual(['p'])
    expect(folded[0]!.childCount).toBe(2)
  })

  it('keeps every row when the tree loops, which only a restored file can write', () => {
    const rows = arrangeTree([task('a', 'b'), task('b', 'a'), task('c')], new Set())
    expect(ids(rows).sort()).toEqual(['a', 'b', 'c'])
  })

  it('never indents past the deepest level the listing draws', () => {
    const chain = [task('1'), task('2', '1'), task('3', '2'), task('4', '3'), task('5', '4')]
    const rows = arrangeTree(chain, new Set())
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 3])
  })

  it('answers with a permutation of what it was given, in every shape', () => {
    const given = [task('a'), task('b', 'a'), task('c', 'a'), task('d', 'c'), task('e')]
    const rows = arrangeTree(given, new Set(['a']))
    expect(ids(rows).length).toBeLessThanOrEqual(given.length)
    expect(arrangeTree(given, new Set()).map((row) => row.task.id).sort())
      .toEqual(given.map((entry) => entry.id).sort())
  })
})

let view: RenderedElement | null = null

/** The list page, with `b` and `c` under `a`. */
function mountTree(): HTMLElement {
  useTodos.setState({
    view: 'list', listId: 'inbox', sort: null, collapsedTasks: [],
    tasks: [task('a'), task('b', 'a'), task('c', 'a'), task('d')],
  })
  view = renderElement(createElement(ListTaskView))
  return view.container
}

function drewRow(container: HTMLElement, id: string): boolean {
  return container.querySelector(`[data-todo-details="${id}"]`) != null
}

/** The fold control of one row, which the row marks as its own. */
function foldButton(container: HTMLElement, id: string): HTMLButtonElement | undefined {
  return container.querySelector<HTMLButtonElement>(`button[data-todo-fold="${id}"]`) ?? undefined
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState({ collapsedTasks: [] })
})

afterEach(() => {
  view?.unmount()
  view = null
  document.body.innerHTML = ''
})

describe('the fold on a listed parent', () => {
  it('names the children it is about, and hides exactly them when pressed', () => {
    const container = mountTree()
    expect(drewRow(container, 'b')).toBe(true)
    const button = foldButton(container, 'a')
    if (!button) throw new Error('the parent row drew no fold control')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-label')).toBe(t('todo.task.collapse_children', { count: 2, title: 'T-a' }))

    act(() => { button.click() })

    expect(drewRow(container, 'a')).toBe(true)
    expect(drewRow(container, 'b')).toBe(false)
    expect(drewRow(container, 'c')).toBe(false)
    // The row that is still on the page is the one that answers for the press.
    expect(useTodos.getState().collapsedTasks).toEqual(['a'])
    const reopened = foldButton(container, 'a')
    if (!reopened) throw new Error('the folded row drew no fold control')
    expect(reopened.getAttribute('aria-expanded')).toBe('false')
    expect(reopened.getAttribute('aria-label')).toBe(t('todo.task.expand_children', { count: 2, title: 'T-a' }))

    act(() => { reopened.click() })
    expect(useTodos.getState().collapsedTasks).toEqual([])
    expect(drewRow(container, 'b')).toBe(true)
  })

  it('draws no fold control on a row with nothing under it', () => {
    const container = mountTree()
    expect(foldButton(container, 'd')).toBeUndefined()
    const row = container.querySelector(`[data-todo-details="d"]`)?.closest('article')
    if (!row) throw new Error('row d drew no body')
    expect(row.querySelector('[data-todo-tree-depth]')).toBeNull()
  })

  it('marks the gutter for a child and not for a top-level row', () => {
    const container = mountTree()
    const parent = container.querySelector(`[data-todo-details="a"]`)?.closest('article')
    const child = container.querySelector(`[data-todo-details="b"]`)?.closest('article')
    expect(parent?.querySelector('[data-todo-tree-depth]')).toBeNull()
    expect(child?.querySelector('[data-todo-tree-depth]')).not.toBeNull()
  })
})

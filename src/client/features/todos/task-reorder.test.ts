// @vitest-environment jsdom
/**
 * Reordering a task without a drag.
 *
 * Drag and drop cannot be exercised in jsdom, so the accessible path is what these cases pin: the
 * card's own menu offers "move up", "move down" and "move to list", each a real menu item reachable
 * from the card's button. The same menu is the phone's substitute for a drag the platform will not
 * give it. What is asserted at the API boundary is the anchor the route receives — the row the task
 * lands before, or null for the end — and the list id only when the move crosses collections. An
 * explicit sort hides the controls, because that order is the reader's chosen reading.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'

const service = vi.hoisted(() => ({
  moves: [] as { id: string; body: { beforeId: string | null; listId?: string | null } }[],
  tasks: [] as TodoTask[],
  lists: [] as TaskListEntry[],
  requests: [] as Record<string, unknown>[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      move: async (id: string, body: { beforeId: string | null; listId?: string | null }) => {
        service.moves.push({ id, body })
        return { task: service.tasks.find((task) => task.id === id)! }
      },
      list: async (params: Record<string, unknown> = {}) => {
        service.requests.push(params)
        return {
          tasks: service.tasks, total: service.tasks.length, counts: counts(),
          dayEnd: Date.now() + 3_600_000, timezone: 'UTC',
        }
      },
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => ({ task: service.tasks.find((task) => task.id === id)!, steps: [] }),
    },
  },
}))

import { ListTaskView } from './TaskViews'
import { useTodos } from './store'

function list(id: string, name: string, parentId: string | null = null): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId }
}

function counts(): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 3, completed: 0, starred: 0, byList: {}, byTag: {} }
}

function task(id: string, title: string, listId: string | null, position: number | null): TodoTask {
  return {
    id, title, description: '', status: 'todo', priority: 'medium',
    dueAt: null, remindAt: null, completedAt: null, createdAt: 0, updatedAt: 0,
    listId, tags: [], starred: false, repeat: null, remindedAt: null,
    plannedFor: null, noteId: null, conversationId: null, projectId: null,
    stepTotal: 0, stepDone: 0, position,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

function openMenu(title: string): void {
  const button = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.task.actions')}: ${title}"]`,
  )
  if (!button) throw new Error(`no actions button for ${title}`)
  act(() => { button.click() })
}

/** One menu row, from the portal the menu draws on the body. */
function menuRow(label: string): HTMLButtonElement {
  const row = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
    .find((entry) => (entry.textContent ?? '').trim() === label)
  if (!row) throw new Error(`no menu row named ${label}`)
  return row
}

function menuRowOrNull(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
    .find((entry) => (entry.textContent ?? '').trim() === label)
}

function choose(label: string): void {
  act(() => { menuRow(label).click() })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.moves.length = 0
  service.requests.length = 0
  service.tasks = [
    task('A', 'Alpha', 'L1', 1000),
    task('B', 'Bravo', 'L1', 2000),
    task('C', 'Charlie', 'L1', 3000),
  ]
  service.lists = [list('L1', 'Work'), list('L2', 'Home')]
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    view: 'list',
    listId: 'L1',
    sort: null,
    tasks: service.tasks,
    completed: [],
    lists: service.lists,
    tags: [],
    counts: counts(),
    dayEnd: Date.now() + 86_400_000,
    timezone: 'UTC',
  })
  view = renderElement(createElement(ListTaskView))
})

afterEach(() => {
  vi.restoreAllMocks()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

describe('the card menu is the keyboard and phone equivalent of a drag', () => {
  it('offers move up and down as real menu items, disabled at the ends', async () => {
    openMenu('Alpha')
    const up = menuRow(t('todo.move.up'))
    const down = menuRow(t('todo.move.down'))
    expect(up.tagName).toBe('BUTTON')
    expect(up.getAttribute('role')).toBe('menuitem')
    expect(up.disabled, 'the first row has nowhere to move up to').toBe(true)
    expect(down.disabled).toBe(false)

    choose(t('todo.move.down'))
    await settle()
    // Moving Alpha down anchors it before the row after its neighbour — Charlie, not an index.
    expect(service.moves).toEqual([{ id: 'A', body: { beforeId: 'C' } }])
  })

  it('does not count a finished row as the open row above', () => {
    const finished: TodoTask = { ...task('D', 'Done', 'L1', 0), status: 'done', completedAt: 1 }
    act(() => { useTodos.setState({ tasks: [finished, ...service.tasks] }) })
    openMenu('Alpha')
    expect(menuRow(t('todo.move.up')).disabled, 'the first open row has nothing open above it').toBe(true)
  })

  it('offers the inbox and the other lists, and sends a list id only when it crosses', async () => {
    openMenu('Alpha')
    choose(t('todo.move.to_list'))
    await settle()

    const home = [...document.querySelectorAll<HTMLButtonElement>('button[data-submenu-row]')]
      .find((row) => (row.textContent ?? '').includes('Home'))
    if (!home) throw new Error('the submenu did not offer the other list')
    act(() => { home.click() })
    await settle()

    expect(service.moves).toEqual([{ id: 'A', body: { beforeId: null, listId: 'L2' } }])
  })

  it('keeps the menu out of a listing whose order is an explicit sort', () => {
    act(() => { useTodos.setState({ sort: 'due' }) })
    openMenu('Alpha')
    expect([...document.querySelectorAll('button[role="menuitem"]')]
      .some((row) => (row.textContent ?? '').includes(t('todo.move.up')))).toBe(false)
  })
})

describe('a list drawn in sections', () => {
  /** A section is a child list; the page reads them off the directory it already holds. */
  async function withSections(): Promise<void> {
    act(() => {
      useTodos.setState({
        lists: [list('L1', 'Work'), list('S1', 'Billing', 'L1'), list('S2', 'Retainers', 'L1')],
        tasks: [
          task('A', 'Alpha', 'L1', 1000),
          task('B', 'Bravo', 'S1', 2000),
          task('C', 'Charlie', 'L1', 3000),
        ],
      })
    })
    await settle()
  }

  function headings(): string[] {
    return [...document.querySelectorAll('section[aria-label]')]
      .map((node) => node.getAttribute('aria-label') ?? '')
      .filter((name) => name !== t('todo.a11y.task_list'))
  }

  it('draws one heading per section, and files each row under its own', async () => {
    await withSections()

    expect(headings()).toEqual([t('todo.group.unsectioned'), 'Billing', 'Retainers'])
    const bodyOf = (heading: string): string => document.querySelector(`section[aria-label="${heading}"]`)?.textContent ?? ''
    expect(bodyOf(t('todo.group.unsectioned'))).toContain('Alpha')
    expect(bodyOf(t('todo.group.unsectioned'))).toContain('Charlie')
    expect(bodyOf(t('todo.group.unsectioned'))).not.toContain('Bravo')
    expect(bodyOf('Billing')).toContain('Bravo')
    expect(bodyOf('Billing')).not.toContain('Alpha')
    // An empty section still stands: it is somewhere to drop a row onto, and one that only appears
    // after something landed in it could not be dropped onto.
    expect(headings()).toContain('Retainers')
  })

  it('reorders inside a section rather than across the page', async () => {
    await withSections()

    // Bravo is alone in Billing: there is no place to trade within its section, so the menu offers no
    // ordering rows at all — and it must not offer to trade with the two rows that merely sit above it.
    openMenu('Bravo')
    expect(menuRowOrNull(t('todo.move.up'))).toBeUndefined()
    expect(menuRowOrNull(t('todo.move.down'))).toBeUndefined()

    // Alpha and Charlie share the list's own group, so Alpha may go down — to the end of that group,
    // which is not the end of the page: Bravo belongs to another section and never becomes a neighbour.
    openMenu('Alpha')
    const down = menuRow(t('todo.move.down'))
    expect(down.disabled).toBe(false)
    choose(t('todo.move.down'))
    await settle()
    expect(service.moves).toEqual([{ id: 'A', body: { beforeId: null } }])
  })

  it('asks for the list and its sections in one read', async () => {
    await withSections()
    await act(async () => {
      await useTodos.getState().load()
    })

    const asked = service.requests.at(-1)
    expect(asked).toMatchObject({ list: 'L1', scope: 'subtree' })
  })

  it('asks no scope of the pages that are not one list', async () => {
    await withSections()
    act(() => { useTodos.setState({ view: 'board' }) })
    await act(async () => {
      await useTodos.getState().load()
    })

    expect(service.requests.at(-1)).not.toHaveProperty('scope')
  })
})

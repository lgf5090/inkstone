// @vitest-environment jsdom
/**
 * Setting a task's priority from the row itself.
 *
 * A board cut by priority arranges its columns by dragging a card from one to the next, and that is the
 * only way the dimension offers: a reader with a keyboard, or a thumb on glass, could read the four
 * columns but not move a row between them. The editor could do it, which makes the editor a requirement
 * rather than a detail — exactly what AGENTS.md rules 10 and 13 refuse. So the card's own menu names the
 * field, through the one write every other card row already uses.
 *
 * The claim each case ends at is the store's row, not a label: pressing "High" has to leave that task
 * reading `high`, and picking the priority a row already wears has to send nothing at all, because a
 * gesture that changed nothing should not bump the row's revision or offer an undo of an empty step.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { PRIORITIES } from './task-menu'
import { priorityLabel } from './todo-ui'
import { type TaskCounts, type TaskPriority, type TodoTask } from '@shared/todos/model'

const server = vi.hoisted(() => ({
  rows: [] as TodoTask[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
}))

vi.mock('../../lib/api', () => {
  const counts: TaskCounts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
    completed: 0, starred: 0, byList: {}, byTag: {},
  }
  return {
    api: {
      todos: {
        list: async () => ({
          tasks: server.rows,
          total: server.rows.length,
          counts: { ...counts, all: server.rows.length },
          dayEnd: Date.now() + 3_600_000,
          timezone: 'UTC',
        }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        update: async (id: string, patch: Record<string, unknown>) => {
          server.updates.push({ id, patch })
          const index = server.rows.findIndex((entry) => entry.id === id)
          const task = { ...server.rows[index]!, ...patch } as TodoTask
          server.rows[index] = task
          return { task, next: null }
        },
      },
    },
  }
})

import { TaskCard } from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, priority: TaskPriority = 'medium', status: TodoTask['status'] = 'todo'): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status,
    priority,
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
    tags: [],
    dependsOn: [],
    blocks: [],
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
  server.rows = []
  server.updates.length = 0
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

function mount(row: TodoTask): void {
  server.rows = [row]
  useTodos.setState({
    status: 'ready',
    view: 'plan',
    tasks: [row],
    total: 1,
    fetched: 1,
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set<string>(),
  })
  view = renderElement(createElement(TaskCard, {
    task: row,
    lists: [],
    bounds: { dayEnd: NOW + DAY, now: NOW },
    timezone: 'UTC',
    onOpen: () => {},
    onStar: () => {},
  }))
}

/** Let the write, the counts it refreshes and the undo offer run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]')
}

function menuLabels(): string[] {
  return [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])]
    .map((node) => (node.textContent ?? '').trim())
}

function menuItem(label: string): HTMLButtonElement {
  const found = [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!found) throw new Error(`the menu has no row named "${label}"`)
  return found
}

/** The kebab's own list, opened the way a reader with a pointer opens it. */
function openKebab(title = 'a'): HTMLButtonElement {
  const trigger = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.task.actions')}: ${title}"]`,
  )
  expect(trigger, 'the row offers no actions button').not.toBeNull()
  act(() => { trigger!.click() })
  return trigger!
}

/** A row of the submenu the priority group opens. */
function submenuRow(label: string): HTMLButtonElement {
  const row = [...document.querySelectorAll<HTMLButtonElement>('button[data-submenu-row]')]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!row) throw new Error(`the submenu has no row named "${label}"`)
  return row
}

/** A right-click on the row's title, which is where a reader actually points. */
function rightClick(): void {
  const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-open]')
  expect(button, 'the row is not rendered').toBeTruthy()
  act(() => {
    button!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }))
  })
}

function priorityOf(id = 'a'): TaskPriority | undefined {
  return useTodos.getState().tasks.find((entry) => entry.id === id)?.priority
}

/** The group's own name, read after the catalog has arrived. */
function priorityGroup(): string {
  return t('todo.layout.group.priority')
}

describe('the priority rows in a card menu', () => {
  it('names the field as a row of its own, and opens it as a real submenu', () => {
    mount(task('a', 'high'))
    openKebab()

    const row = menuItem(priorityGroup())
    expect(row.tagName).toBe('BUTTON')
    expect(row.getAttribute('role')).toBe('menuitem')
    expect(row.getAttribute('aria-haspopup'), 'the priority row opens nothing').toBe('menu')

    act(() => { row.click() })
    const panel = document.querySelector<HTMLElement>('[role="group"]')
    expect(panel, 'the priority row opened no panel').not.toBeNull()
    expect(panel!.getAttribute('aria-label')).toBe(priorityGroup())
    expect([...panel!.querySelectorAll<HTMLButtonElement>('button[data-submenu-row]')]
      .map((node) => (node.textContent ?? '').trim()))
      .toEqual(PRIORITIES.map((priority) => priorityLabel(priority)))
  })

  it('marks the priority the row already wears', () => {
    mount(task('a', 'medium'))
    openKebab()
    act(() => { menuItem(priorityGroup()).click() })

    expect(submenuRow(priorityLabel('medium')).querySelector('svg.lucide-check'), 'the current priority is not marked')
      .not.toBeNull()
    expect(submenuRow(priorityLabel('high')).querySelector('svg.lucide-check')).toBeNull()
  })

  it('leaves the store holding the priority a reader pressed', async () => {
    mount(task('a', 'medium'))
    openKebab()
    act(() => { menuItem(priorityGroup()).click() })
    act(() => { submenuRow(priorityLabel('high')).click() })
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { priority: 'high' } }])
    // Not the request alone: the row on screen is the one that has to read differently afterwards.
    expect(priorityOf()).toBe('high')
  })

  it('sends nothing when the reader picks the priority the row already has', async () => {
    mount(task('a', 'urgent'))
    openKebab()
    act(() => { menuItem(priorityGroup()).click() })
    act(() => { submenuRow(priorityLabel('urgent')).click() })
    await settle()

    // A write that changes nothing still bumps the row's revision and offers an undo of an empty step.
    expect(server.updates, 'an unchanged priority was still sent').toEqual([])
    expect(priorityOf()).toBe('urgent')
  })

  it('closes the menu the way every other row does', () => {
    mount(task('a', 'low'))
    openKebab()
    act(() => { menuItem(priorityGroup()).click() })
    expect(menu(), 'the submenu left the menu up').not.toBeNull()

    act(() => { submenuRow(priorityLabel('high')).click() })
    expect(menu(), 'the row left the menu open under the reader').toBeNull()
  })

  it('carries the same rows into the menu a right-click opens', () => {
    mount(task('a', 'medium'))
    openKebab()
    const offeredByKebab = menuLabels()
    expect(offeredByKebab).toContain(priorityGroup())
    // The same trigger is what shuts it, exactly as a reader's second tap does.
    openKebab()

    rightClick()
    const strip = [
      t('todo.date.today'),
      t('todo.date.tomorrow'),
      t('todo.date.next_week'),
      t('todo.date.pick'),
    ]
    expect(menuLabels()).toEqual([...strip, ...offeredByKebab])
  })

  it('reaches a priority from the submenu by the same click a thumb makes', async () => {
    mount(task('a', 'medium'))
    openKebab()
    act(() => { menuItem(priorityGroup()).click() })
    // The submenu rows are real buttons: a keyboard reader who reaches the panel presses the same node
    // a pointer aims at, and a touch device gets the identical list because the kebab is a tap.
    const row = submenuRow(priorityLabel('urgent'))
    expect(row.tagName).toBe('BUTTON')
    act(() => { row.click() })
    await settle()

    expect(priorityOf()).toBe('urgent')
  })
})

describe('a finished row', () => {
  it('still has nothing to schedule or be reminded about, priority included', () => {
    mount(task('a', 'medium', 'done'))
    rightClick()

    expect(menuLabels()).not.toContain(priorityGroup())
  })
})

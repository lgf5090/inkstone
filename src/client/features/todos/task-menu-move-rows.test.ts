// @vitest-environment jsdom
/**
 * The move rows a card menu is allowed to show.
 *
 * A pair of greyed rows that both refuse to do anything is not a disabled control, it is a dead end
 * drawn twice — and this repository has been caught four times putting a disabled row where no reader
 * could press it. A row at one end of a listing still wants both halves of the pair, because "up" is
 * how that reader learns they are standing at the top. A listing that has no up or down at all — the
 * board's priority columns, where a hand-written place does not exist — wants neither, and the whole
 * pair leaves the menu rather than sitting there greyed.
 *
 * "Move to list" stays through all of it: it is a different question, and a priority column still
 * answers it.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

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
          return { task: { ...server.rows[0]!, ...patch } as TodoTask, next: null }
        },
      },
    },
  }
})

import { TaskCard, type TaskMoveControls } from './TaskCard'
import { snoozeLabel, useTodos } from './store'
import { SNOOZE_MINUTES } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'


const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(): TodoTask {
  return {
    id: 'a',
    title: 'a',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: 'L1',
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
    position: 1000,
  }
}

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
}

function controls(overrides: Partial<TaskMoveControls> = {}): TaskMoveControls {
  return {
    dragEnabled: true,
    onDrop: vi.fn(),
    order: { up: true, down: true, moveUp: vi.fn(), moveDown: vi.fn() },
    onMoveToList: vi.fn(),
    ...overrides,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.rows = [task()]
  server.updates.length = 0
  useTodos.setState(original, true)
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
})

function mount(move: TaskMoveControls | undefined, lists: TaskListEntry[] = [list('L1', 'Work'), list('L2', 'Home')]): void {
  useTodos.setState({
    status: 'ready',
    view: 'plan',
    tasks: [task()],
    total: 1,
    fetched: 1,
    lists,
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set<string>(),
  })
  view = renderElement(createElement(TaskCard, {
    task: task(),
    lists,
    bounds: { dayEnd: NOW + DAY, now: NOW },
    timezone: 'UTC',
    onOpen: () => {},
    onStar: () => {},
    ...(move ? { move } : {}),
  }))
}

function openKebab(): void {
  const trigger = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.task.actions')}: a"]`,
  )
  expect(trigger, 'the row offers no actions button').not.toBeNull()
  act(() => { trigger!.click() })
}

function menu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]')
}

function menuLabels(): string[] {
  return [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])]
    .map((node) => (node.textContent ?? '').trim())
}

function menuRow(label: string): HTMLButtonElement {
  const row = [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((node) => (node.textContent ?? '').trim() === label)
  if (!row) throw new Error(`the menu has no row named "${label}"`)
  return row
}

describe('the pair of move rows', () => {
  it('draws both when one of them can still be pressed', () => {
    mount(controls({ order: { up: false, down: true, moveUp: vi.fn(), moveDown: vi.fn() } }))
    openKebab()

    expect(menuLabels()).toContain(t('todo.move.up'))
    expect(menuLabels()).toContain(t('todo.move.down'))
    // The row at the top of a listing is told which end it is standing at rather than left to guess.
    expect(menuRow(t('todo.move.up')).disabled).toBe(true)
    expect(menuRow(t('todo.move.down')).disabled).toBe(false)
  })

  it('draws both at the other end too', () => {
    mount(controls({ order: { up: true, down: false, moveUp: vi.fn(), moveDown: vi.fn() } }))
    openKebab()

    expect(menuRow(t('todo.move.up')).disabled).toBe(false)
    expect(menuRow(t('todo.move.down')).disabled).toBe(true)
  })

  it('draws neither where no move is possible at all', () => {
    mount(controls({ order: { up: false, down: false, moveUp: vi.fn(), moveDown: vi.fn() } }))
    openKebab()

    expect(menuLabels()).not.toContain(t('todo.move.up'))
    expect(menuLabels()).not.toContain(t('todo.move.down'))
    // The rest of the menu is untouched: the group that has nothing to say is the only one that goes.
    expect(menuLabels()).toEqual([
      t('todo.status.mark_in_progress'),
      t('todo.layout.group.priority'),
      t('todo.move.to_list'),
      ...SNOOZE_MINUTES.map((minutes) => snoozeLabel(minutes)),
    ])
  })

  it('leaves the whole group out where the order is not the reader\'s', () => {
    mount(undefined)
    openKebab()

    expect(menuLabels()).toEqual([
      t('todo.status.mark_in_progress'),
      t('todo.layout.group.priority'),
      ...SNOOZE_MINUTES.map((minutes) => snoozeLabel(minutes)),
    ])
  })

  it('keeps the divider the hidden pair wore, above the group that came after', () => {
    mount(controls({ order: { up: false, down: false, moveUp: vi.fn(), moveDown: vi.fn() } }))
    openKebab()

    // Nothing wears a divider above the first row of all, whatever groups were skipped under it.
    const head = menuRow(t('todo.status.mark_in_progress'))
    expect(head.previousElementSibling?.getAttribute('role') ?? null, 'a divider was drawn above the whole menu').toBeNull()

    // The reminders still arrive as their own group, so the line that used to sit above the moves has
    // moved with the group rather than being left behind on a row that is no longer drawn.
    const firstReminder = menuRow(snoozeLabel(SNOOZE_MINUTES[0]!))
    expect(firstReminder.previousElementSibling?.getAttribute('role'), 'the reminder group lost its divider').toBe('separator')
    // The row draws four groups with the pair gone — the status, the priority, "move to list", the
    // reminders — and one fewer divider between them. A hidden group never leaves its line behind.
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(3)
  })
})

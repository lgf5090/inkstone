// @vitest-environment jsdom
/**
 * The menu a right-click opens on a task row, and the schedule strip on top of it.
 *
 * C1 was blunt: the to-do app had no context menu anywhere while `useContextMenu()` and `Menu` had sat
 * in `components/overlay` since the note tree learned to right-click. Two things are pinned here.
 *
 * The first is parity. The rows a right-click offers below its strip are the very rows the card's own
 * kebab button offers, because one function builds both — a second copy of the list is the shape that
 * drifts the first time somebody adds a row to only one of them.
 *
 * The second is reachability. A quick row is only worth having if pressing it moves the task, so every
 * case below ends at the store's own row rather than at a label, and the schedule strip is checked
 * against the end of the account zone's day — the reading `quick-parse.ts` and the server's `parseDue`
 * both apply — never against a midnight nobody asked for.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { SNOOZE_MINUTES, type TaskCounts, type TaskTag, type TodoTask } from '@shared/todos/model'

/** What the fake server holds, and every request the client actually made. */
const server = vi.hoisted(() => ({
  rows: [] as TodoTask[],
  lists: [] as TaskListEntry[],
  tags: [] as TaskTag[],
  timezone: 'UTC',
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  batches: [] as { ids: string[]; op: string; value?: unknown }[],
}))

vi.mock('../../lib/api', async () => {
  // The route reads a date the same way (`routes/todos.ts`'s `parseDue`), so a bare day answers with
  // that day's 23:59 in the account zone rather than with something the client invented.
  const { parseLocalTime } = await import('@shared/assistant-time')
  const counts: TaskCounts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
    completed: 0, starred: 0, byList: {}, byTag: {},
  }
  const readDueAt = (value: unknown, current: number | null): number | null => {
    if (value === undefined) return current
    if (value === null || value === '') return null
    if (typeof value === 'number') return value
    return parseLocalTime(String(value), server.timezone)
  }
  return {
    api: {
      todos: {
        list: async () => ({
          tasks: server.rows,
          total: server.rows.length,
          counts: { ...counts, all: server.rows.length },
          dayEnd: Date.now() + 3_600_000,
          timezone: server.timezone,
        }),
        lists: async () => ({ lists: server.lists }),
        tags: async () => ({ tags: server.tags }),
        update: async (id: string, patch: Record<string, unknown>) => {
          server.updates.push({ id, patch })
          const index = server.rows.findIndex((entry) => entry.id === id)
          const before = server.rows[index]!
          const task: TodoTask = {
            ...before,
            ...patch,
            dueAt: readDueAt(patch.dueAt, before.dueAt),
            updatedAt: Date.now(),
          } as TodoTask
          server.rows[index] = task
          return { task, next: null }
        },
        batch: async (body: { ids: string[]; op: string; value?: unknown }) => {
          server.batches.push(body)
          if (body.op === 'complete') {
            server.rows = server.rows.map((entry) => (
              body.ids.includes(entry.id) ? { ...entry, status: 'done' as const } : entry
            ))
          }
          return { done: body.ids, failed: [] }
        },
      },
    },
  }
})

import { TaskCard, type TaskMoveControls } from './TaskCard'
import { snoozeLabel, useTodos, type TaskListEntry } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

/**
 * The strip's rows, in the order the card puts them: the three quick days, then the picker. Read after
 * `initI18n()`, which is when the catalog arrives — a module-level constant would hold the bare keys.
 * A row that already has a date adds the way to clear it after these four.
 */
function stripRows(): string[] {
  return [t('todo.date.today'), t('todo.date.tomorrow'), t('todo.date.next_week'), t('todo.date.pick')]
}

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
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

function list(id: string, name: string): TaskListEntry {
  return { id, name, icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null }
}

function tag(id: string, name: string): TaskTag {
  return { id, name, color: null, createdAt: 0, updatedAt: 0, openCount: 0 }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  server.rows = []
  server.lists = []
  server.tags = []
  server.timezone = 'UTC'
  server.updates.length = 0
  server.batches.length = 0
  useTodos.setState(original, true)
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.unstubAllGlobals()
})

interface MountOptions {
  timezone?: string
  /** The instant the row is read at: the strip's days are counted from it, never from the browser clock. */
  now?: number
  lists?: TaskListEntry[]
  tags?: TaskTag[]
  move?: TaskMoveControls
  selected?: string[]
}

/** One row, on the clock and in the zone the rest of the case names. */
function mount(row: TodoTask, options: MountOptions = {}): void {
  const timezone = options.timezone ?? 'UTC'
  const now = options.now ?? NOW
  const lists = options.lists ?? []
  const tags = options.tags ?? []
  server.rows = [row]
  server.lists = lists
  server.tags = tags
  server.timezone = timezone
  useTodos.setState({
    status: 'ready',
    view: 'plan',
    tasks: [row],
    total: 1,
    fetched: 1,
    lists,
    tags,
    timezone,
    dayEnd: now + DAY,
    selectedIds: new Set(options.selected ?? []),
  })
  view = renderElement(createElement(TaskCard, {
    task: row,
    lists,
    bounds: { dayEnd: now + DAY, now },
    timezone,
    onOpen: () => {},
    onStar: () => {},
    move: options.move,
  }))
}

function press(node: Element | null | undefined, what: string, event: Event = new MouseEvent('click', { bubbles: true, cancelable: true })): void {
  expect(node, `${what} is not rendered`).toBeTruthy()
  act(() => { node!.dispatchEvent(event) })
}

/** A right-click at the row's title, which is where a reader actually points. */
function rightClick(): void {
  const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-open]')
  press(button, 'the row', new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }))
}

function kebab(): HTMLButtonElement | null {
  return view!.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.task.actions')}: a"]`)
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

/** Let the write, the reload behind it and the toast run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  })
}

function dueOf(id = 'a'): number | null {
  return useTodos.getState().tasks.find((entry) => entry.id === id)?.dueAt ?? null
}

describe('a right-clicked row', () => {
  it('answers it with a menu, and takes the browser menu away', () => {
    mount(task('a'))
    const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-open]')
    expect(button, 'the row is not rendered').toBeTruthy()

    // `dispatchEvent` answers false once a handler has cancelled the event, which here is the browser's
    // own menu being asked to stay out of the way.
    let handled = true
    act(() => {
      handled = button!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(handled, 'the row left the browser menu in place').toBe(false)

    expect(menu(), 'the right-click opened no menu').not.toBeNull()
    expect(menu()!.getAttribute('aria-label')).toBe(t('todo.task.actions'))
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(stripRows().length)
  })

  it('stays shut under a phone long press, which is the row\'s own selection gesture', () => {
    mount(task('a'))
    vi.useFakeTimers()
    const button = view!.container.querySelector<HTMLButtonElement>('[data-todo-open]')

    press(button, 'the row', new Event('pointerdown', { bubbles: true }))
    act(() => { vi.advanceTimersByTime(600) })
    // Android answers the same long press with a `contextmenu`, and the menu would be a second answer.
    press(button, 'the row', new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    expect(menu(), 'the long press opened a context menu beside the selection').toBeNull()
    expect(useTodos.getState().selectedIds.has('a')).toBe(true)
  })

  it('opens with the schedule strip and then exactly the rows the kebab offers', () => {
    mount(task('a', { status: 'in_progress' }))

    press(kebab(), 'the kebab')
    const offeredByKebab = menuLabels()
    press(kebab(), 'the kebab')

    rightClick()
    expect(menuLabels()).toEqual([...stripRows(), ...offeredByKebab])
  })

  it('keeps the kebab on the rows it had before the strip existed', async () => {
    mount(task('a', { status: 'in_progress' }))
    press(kebab(), 'the kebab')

    expect(menuLabels()).toEqual([
      t('todo.status.mark_todo'),
      t('todo.layout.group.priority'),
      ...SNOOZE_MINUTES.map((minutes) => snoozeLabel(minutes)),
    ])

    press(menuItem(t('todo.status.mark_todo')), 'the status row')
    await settle()
    expect(server.updates).toEqual([{ id: 'a', patch: { status: 'todo' } }])
  })

  it('writes tomorrow at the end of the account day, and the row really moves', async () => {
    mount(task('a'))
    rightClick()
    press(menuItem(t('todo.date.tomorrow')), 'the tomorrow row')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-10-21' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 9, 21, 23, 59))
  })

  it('keeps today inside today rather than rolling it over', async () => {
    mount(task('a'))
    rightClick()
    press(menuItem(t('todo.date.today')), 'the today row')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-10-20' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 9, 20, 23, 59))
  })

  it('reads the account zone across a daylight-saving change, not the browser clock', async () => {
    // 04:30Z on 8 March 2026 is 23:30 on the 7th in New York, and the 8th is the day the clock jumps.
    mount(task('a'), { timezone: 'America/New_York', now: Date.parse('2026-03-08T04:30:00Z') })
    rightClick()
    press(menuItem(t('todo.date.today')), 'the today row')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-03-07' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 2, 7, 23, 59) + 5 * 3_600_000)

    rightClick()
    press(menuItem(t('todo.date.tomorrow')), 'the tomorrow row')
    await settle()
    expect(dueOf()).toBe(Date.UTC(2026, 2, 8, 23, 59) + 4 * 3_600_000)
  })

  it('offers the way a week out', async () => {
    mount(task('a'))
    rightClick()
    press(menuItem(t('todo.date.next_week')), 'the next-week row')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-10-27' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 9, 27, 23, 59))
  })

  it('offers to clear a date the row has, and sends null', async () => {
    mount(task('a', { dueAt: Date.UTC(2026, 9, 24, 23, 59) }))
    rightClick()
    press(menuItem(t('todo.date.clear')), 'the clear row')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: null } }])
    expect(dueOf()).toBeNull()
  })

  it('does not offer to clear a date there is nothing to clear', () => {
    mount(task('a'))
    rightClick()

    expect(menu(), 'the right-click opened no menu').not.toBeNull()
    expect(menuLabels()).toEqual([...stripRows(), t('todo.status.mark_in_progress'), t('todo.layout.group.priority'), ...SNOOZE_MINUTES.map((minutes) => snoozeLabel(minutes))])
    expect(menuLabels()).not.toContain(t('todo.date.clear'))
  })

  it('reaches the app date picker from the strip and writes the day it picks', async () => {
    mount(task('a', { dueAt: Date.UTC(2026, 9, 15, 23, 59) }))
    rightClick()

    const pick = menuItem(t('todo.date.pick'))
    expect(pick.getAttribute('aria-haspopup')).toBe('menu')
    press(pick, 'the pick-a-date row')

    const panel = document.querySelector<HTMLElement>('[role="group"]')
    expect(panel, 'the row opened no panel').not.toBeNull()
    // The shared picker names its own trigger with a screen-reader span, so the dialog affordance is
    // what identifies it here rather than an `aria-label` it does not write.
    press(panel!.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]'), 'the date picker field')

    const calendar = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(calendar, 'the shared date picker did not open').not.toBeNull()
    const day = [...calendar!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === '22')
    press(day, 'the 22nd')
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-10-22' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 9, 22, 23, 59))
  })

  it('lets the keyboard take the first quick row without a pointer', async () => {
    mount(task('a'))
    rightClick()
    expect(menu(), 'the right-click opened no menu').not.toBeNull()

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle()

    expect(server.updates).toEqual([{ id: 'a', patch: { dueAt: '2026-10-20' } }])
    expect(dueOf()).toBe(Date.UTC(2026, 9, 20, 23, 59))
  })

  it('carries the move rows into the same menu, submenu and all', async () => {
    const move: TaskMoveControls = {
      dragEnabled: true,
      canMoveUp: true,
      canMoveDown: false,
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
      onMoveToList: vi.fn(),
      onDropBefore: vi.fn(),
      onDropAfter: vi.fn(),
    }
    mount(task('a', { listId: 'L1' }), { lists: [list('L1', 'Work'), list('L2', 'Home')], move })
    rightClick()

    press(menuItem(t('todo.move.to_list')), 'the move-to-list row')
    const panel = document.querySelector<HTMLElement>('[role="group"]')
    expect(panel, 'the submenu opened no panel').not.toBeNull()
    const target = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === 'Home')
    press(target, 'the Home row')

    expect(move.onMoveToList).toHaveBeenCalledWith('L2')
  })

  it('leaves the reminder rows off a finished task', () => {
    mount(task('a', { status: 'done' }))
    rightClick()

    expect(menuLabels()).toEqual(stripRows())
    expect(kebab(), 'a finished row still offers a kebab').toBeNull()
  })

  it('leaves them off a row that is neither finished nor owed', () => {
    // The priority and reminder rows sort and schedule work the reader still has. A row in neither set
    // answers the same way a finished one does — and must not be drawn into the menu by the absence of
    // a `done` match, which is how a `cancelled` row would otherwise keep arriving with a flag on it.
    mount(task('a', { status: 'cancelled' as TodoTask['status'] }))
    rightClick()

    expect(menuLabels()).toEqual(stripRows())
    expect(kebab(), 'an abandoned row still offers a kebab').toBeNull()
  })
})

describe('a right-click while rows are picked', () => {
  it('offers the batch bar actions rather than one row\'s schedule', () => {
    server.rows = [task('a'), task('b')]
    mount(task('a'), { selected: ['a', 'b'] })
    expect(kebab(), 'a row being picked offers no single-row menu').toBeNull()

    rightClick()
    const offered = menuLabels()
    for (const label of [t('todo.batch.complete'), t('todo.batch.move'), t('todo.batch.priority'), t('todo.batch.tag'), t('todo.batch.delete')]) {
      expect(offered, `the batch menu has no ${label}`).toContain(label)
    }
    expect(offered).not.toContain(t('todo.date.tomorrow'))
  })

  it('runs the batch on every picked id when a row is pressed', async () => {
    server.rows = [task('a'), task('b')]
    mount(task('a'), { selected: ['a', 'b'] })
    rightClick()
    press(menuItem(t('todo.batch.complete')), 'the complete row')
    await settle()

    expect(server.batches).toEqual([{ ids: ['a', 'b'], op: 'complete' }])
    expect(useTodos.getState().selectedIds.size).toBe(0)
  })

  it('reaches a list through the batch menu\'s own submenu', async () => {
    server.rows = [task('a'), task('b')]
    mount(task('a'), { lists: [list('L1', 'Work')], selected: ['a', 'b'] })
    rightClick()
    press(menuItem(t('todo.batch.move')), 'the move row')

    const panel = document.querySelector<HTMLElement>('[role="group"]')
    expect(panel, 'the batch menu opened no submenu').not.toBeNull()
    const target = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === t('todo.smart.inbox'))
    press(target, 'the Inbox row')
    await settle()

    expect(server.batches).toEqual([{ ids: ['a', 'b'], op: 'move', value: null }])
  })

  it('puts a tag on every picked row through the same submenu shape', async () => {
    server.rows = [task('a'), task('b')]
    mount(task('a'), { tags: [tag('tag-1', 'Focus')], selected: ['a', 'b'] })
    rightClick()
    press(menuItem(t('todo.batch.tag')), 'the tag row')

    const panel = document.querySelector<HTMLElement>('[role="group"]')
    expect(panel, 'the batch menu opened no submenu').not.toBeNull()
    const target = [...panel!.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => (node.textContent ?? '').trim() === 'Focus')
    press(target, 'the Focus row')
    await settle()

    expect(server.batches).toEqual([{ ids: ['a', 'b'], op: 'tag', value: 'Focus' }])
  })
})

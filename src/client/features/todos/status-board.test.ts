// @vitest-environment jsdom
/**
 * One page of tasks read as columns of a derived dimension.
 *
 * The split is a reading of rows the server already scoped and ordered: a column keeps the order the
 * page arrived in, and an empty column says so instead of leaving a strip that looks broken. What a
 * column *stands for* is the reader's choice — status, list or priority — and dropping a task into one
 * writes the field that column is cut by: the status, the list (through the anchored move, so the row
 * lands at the end of the destination list rather than carrying its old number into the middle of the
 * new one), or the priority. A priority column never reorders anything, because a hand-written place
 * belongs to a list and not to a priority, and that limit is drawn rather than hidden.
 *
 * The arrangement lives in the address (`layout=columns&group=…`), so it is opened by a reload or a
 * pasted link and falls back to the ordinary list where columns would not fit.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, stubBreakpoint, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TaskStatus, TodoTask } from '@shared/todos/model'
import type { TaskListEntry } from '../../lib/api'

const service = vi.hoisted(() => ({
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  moves: [] as { id: string; body: { beforeId: string | null; listId?: string | null } }[],
  rows: [] as TodoTask[],
  lists: [] as TaskListEntry[],
}))

vi.mock('../../lib/api', () => ({
  api: {
    todos: {
      list: async () => ({
        tasks: service.rows,
        total: service.rows.length,
        counts: counts(),
        dayEnd: Date.now() + 3_600_000,
        timezone: 'UTC',
      }),
      lists: async () => ({ lists: service.lists }),
      tags: async () => ({ tags: [] }),
      get: async (id: string) => ({ task: service.rows.find((entry) => entry.id === id) ?? null, steps: [] }),
      update: async (id: string, patch: Record<string, unknown>) => {
        service.updates.push({ id, patch })
        const row = service.rows.find((entry) => entry.id === id)!
        const next = { ...row, ...patch }
        service.rows = service.rows.map((entry) => (entry.id === id ? next : entry))
        return { task: next, next: null }
      },
      move: async (id: string, body: { beforeId: string | null; listId?: string | null }) => {
        service.moves.push({ id, body })
        return { task: service.rows.find((entry) => entry.id === id)! }
      },
    },
  },
}))

import { ListTaskView } from './TaskViews'
import { StatusBoard } from './status-board'
import type { BoardDimension } from './task-groups'
import { TODO_DRAG_TYPE } from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function counts(): TaskCounts {
  return { inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0, completed: 0, starred: 0, byList: {}, byTag: {} }
}

function list(id: string, name: string, position: number): TaskListEntry {
  return {
    id, name, icon: null, color: null, position,
    createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0, archivedAt: null, parentId: null,
  }
}

function task(id: string, status: TaskStatus = 'todo', extra: Partial<TodoTask> = {}): TodoTask {
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
    listId: 'L1',
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
    position: 1000 + id.charCodeAt(0),
    ...extra,
  }
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.updates.length = 0
  service.moves.length = 0
  service.lists = [list('L1', 'Work', 0), list('L2', 'Home', 1)]
  service.rows = []
  useTodos.setState(original, true)
  useTodos.setState({
    status: 'ready',
    tasks: [],
    completed: [],
    lists: service.lists,
    tags: [],
    counts: counts(),
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    view: 'list',
    listId: 'L1',
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

/** The board on its own, at one dimension; any board already on the page comes down first. */
function renderBoard(rows: TodoTask[], group: BoardDimension = 'status'): void {
  service.rows = rows
  if (view) {
    const mounted = view
    act(() => { mounted.unmount() })
    view = null
    // A menu is a portal on the body, so the page is put back the way a reload would put it.
    document.body.innerHTML = ''
  }
  act(() => { useTodos.setState({ tasks: rows }) })
  view = renderElement(createElement(StatusBoard, { tasks: rows, group }))
}

function renderList(rows: TodoTask[]): void {
  service.rows = rows
  act(() => { useTodos.setState({ tasks: rows }) })
  view = renderElement(createElement(ListTaskView))
}

/** One column of the board, whatever dimension it is cut by. */
function column(key: string): HTMLElement {
  const node = view!.container.querySelector<HTMLElement>(`[data-todo-board-column="${key}"]`)
  if (!node) throw new Error(`no ${key} column`)
  return node
}

function columns(): string[] {
  return [...view!.container.querySelectorAll<HTMLElement>('[data-todo-board-column]')]
    .map((node) => node.getAttribute('data-todo-board-column') ?? '')
}

/** The task ids a column holds, in the order they are drawn. */
function order(key: string): string[] {
  return [...column(key).querySelectorAll<HTMLElement>('[data-todo-open]')]
    .map((node) => node.getAttribute('data-todo-open') ?? '')
}

/** The transfer a browser hands a drop target: our own type, carrying one task id. */
function transfer(draggedId: string): DataTransfer {
  const bag = new Map([[TODO_DRAG_TYPE, draggedId]])
  const dataTransfer = {
    getData: (key: string) => bag.get(key) ?? '',
    setData: (key: string, value: string) => { bag.set(key, value) },
    dropEffect: 'none',
    effectAllowed: 'unset',
  }
  Object.defineProperty(dataTransfer, 'types', { get: () => [...bag.keys()], configurable: true })
  return dataTransfer as unknown as DataTransfer
}

/**
 * The drop a pointer would make, without the pointer.
 *
 * jsdom has no drag engine, so the events are dispatched at the node the reader aimed at — the column
 * for a drop on its body, the card for a drop between two rows — with the same payload a browser
 * carries. What the surface does with it is the part under test.
 */
async function dropOn(node: Element, draggedId: string): Promise<void> {
  for (const type of ['dragover', 'drop'] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer(draggedId) })
    await act(async () => {
      node.dispatchEvent(event)
      await Promise.resolve()
      await Promise.resolve()
    })
  }
}

const dropOnColumn = (key: string, draggedId: string): Promise<void> => dropOn(column(key), draggedId)

/**
 * The half of a drag that paints a gap: the pointer arriving over a node with a row in hand.
 *
 * Only the dragover is sent, because what is under test is the promise the row makes — a line drawn for
 * a place the column cannot give is the defect, and it is drawn here rather than at the drop.
 */
async function dragOverOn(node: Element, draggedId: string): Promise<void> {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: transfer(draggedId) },
    // A real pointer always names where over the row it arrived; jsdom reports no layout, so which half
    // of the row the line lands on is not something this room can answer — only whether it is drawn.
    clientY: { value: 20 },
  })
  await act(async () => {
    node.dispatchEvent(event)
    await Promise.resolve()
  })
}

/** The card row of a task, which is the node that owns a drop between two rows. */
function cardOf(id: string): HTMLElement {
  const open = view!.container.querySelector<HTMLElement>(`[data-todo-open="${id}"]`)
  const card = open?.closest('article')
  if (!card) throw new Error(`no card for ${id}`)
  return card
}

/** The card's own actions menu, opened the way a keyboard reader opens it. */
function openMenu(title: string): void {
  const button = view!.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${t('todo.task.actions')}: ${title}"]`,
  )
  if (!button) throw new Error(`no actions button for ${title}`)
  act(() => { button.click() })
}

function menuRow(label: string): HTMLButtonElement {
  const row = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button[role="menuitemcheckbox"]')]
    .find((entry) => (entry.textContent ?? '').trim() === label)
  if (!row) throw new Error(`no menu row named ${label}`)
  return row
}

/** One option of the dimension switch, picked from the portal the menu draws. */
async function chooseGroup(label: string): Promise<void> {
  const trigger = view!.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.layout.group.label')}"]`)
  if (!trigger) throw new Error('no group switch')
  await act(async () => {
    trigger.click()
    await Promise.resolve()
  })
  await act(async () => {
    menuRow(label).click()
    await Promise.resolve()
  })
}

describe('the board cut by status', () => {
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

  it('drops a task into the column of another status, which writes the status and nothing else', async () => {
    renderBoard([task('a', 'todo'), task('b', 'in_progress')])

    await dropOnColumn('done', 'a')

    expect(service.updates).toEqual([{ id: 'a', patch: { status: 'done' } }])
    // Status is not a collection: a row keeps its place in its list, so no anchored move is asked for.
    expect(service.moves).toEqual([])
  })

  it('writes nothing when a task is dropped into the status it already has', async () => {
    renderBoard([task('a', 'todo'), task('b', 'in_progress')])

    await dropOnColumn('todo', 'a')

    expect(service.updates).toEqual([])
    expect(service.moves).toEqual([])
  })
})

describe('the board cut by list', () => {
  it('draws the inbox and every list the reader has, in the order the sidebar uses', () => {
    renderBoard([task('a', 'todo', { listId: 'L1' }), task('b', 'todo', { listId: 'L2' }), task('c', 'todo', { listId: null })], 'list')

    expect(columns()).toEqual(['inbox', 'L1', 'L2'])
    expect(order('L1')).toEqual(['a'])
    expect(order('L2')).toEqual(['b'])
    expect(order('inbox')).toEqual(['c'])
    // A column of this dimension is named by the collection it holds, not by a status word.
    expect(column('L2').querySelector('h2')?.textContent).toContain('Home')
    expect(column('inbox').querySelector('h2')?.textContent).toContain(t('todo.smart.inbox'))
  })

  it('moves a task dropped into another list by appending it to that list', async () => {
    renderBoard([task('a', 'todo', { listId: 'L1' }), task('b', 'todo', { listId: 'L2' })], 'list')

    await dropOnColumn('L2', 'a')

    // The anchored move with the empty anchor — the destination's end. Patching `listId` alone would
    // carry `a`'s number in `L1`'s manual sequence into the middle of `L2`'s, which is the defect this
    // column shape must not resurrect.
    expect(service.moves).toHaveLength(1)
    expect(service.moves[0]!.id).toBe('a')
    expect(service.moves[0]!.body.beforeId).toBeNull()
    expect(service.moves[0]!.body.listId).toBe('L2')
    expect(Object.keys(service.moves[0]!.body).sort()).toEqual(['beforeId', 'listId'])
    expect(service.updates).toEqual([])
  })

  it('takes a task back to the inbox with an explicit null list rather than an absent one', async () => {
    renderBoard([task('a', 'todo', { listId: 'L2' })], 'list')

    await dropOnColumn('inbox', 'a')

    expect(service.moves).toHaveLength(1)
    expect(service.moves[0]!.body.beforeId).toBeNull()
    expect('listId' in service.moves[0]!.body, 'an omitted list id means "stay where you are"').toBe(true)
    expect(service.moves[0]!.body.listId).toBeNull()
    expect(service.updates).toEqual([])
  })

  it('leaves a task alone that is dropped into its own list', async () => {
    renderBoard([task('a', 'todo', { listId: 'L1' }), task('b', 'todo', { listId: 'L2' })], 'list')

    await dropOnColumn('L1', 'a')

    expect(service.moves).toEqual([])
    expect(service.updates).toEqual([])
  })
})

describe('the board cut by priority', () => {
  it('draws four columns from urgent down and files each row under its own priority', () => {
    renderBoard([
      task('a', 'todo', { priority: 'medium' }),
      task('b', 'todo', { priority: 'urgent' }),
      task('c', 'todo', { priority: 'low' }),
    ], 'priority')

    expect(columns()).toEqual(['urgent', 'high', 'medium', 'low'])
    expect(order('urgent')).toEqual(['b'])
    expect(order('medium')).toEqual(['a'])
    expect(order('low')).toEqual(['c'])
    // Four priorities, one of them empty, still say so rather than leaving a blank strip.
    expect(column('high').textContent).toContain(t('todo.board.empty_column'))
    expect(column('urgent').querySelector('h2')?.textContent).toContain(t('todo.priority.urgent'))
  })

  it('writes the priority and never a place when a task is dropped into another column', async () => {
    renderBoard([task('a', 'todo', { priority: 'medium' }), task('b', 'todo', { priority: 'urgent' })], 'priority')

    await dropOnColumn('high', 'a')

    expect(service.updates).toEqual([{ id: 'a', patch: { priority: 'high' } }])
    // A hand-written place is scoped to a list, not to a priority: writing one here would file the row
    // somewhere in the list its priority has nothing to do with.
    expect(service.moves).toEqual([])
  })

  it('says under the columns that the rows inside them are not reordered', () => {
    renderBoard([task('a', 'todo', { priority: 'medium' }), task('b', 'todo', { priority: 'high' })], 'priority')

    // The limit is drawn where the reader sees it, rather than left as a drag that does nothing.
    expect(view!.container.querySelector('[data-todo-board-hint]')?.textContent).toBe(t('todo.board.priority_hint'))

    // The other two dimensions do reorder inside a column, so the same words would be a lie there.
    renderBoard([task('a', 'todo'), task('b', 'in_progress')], 'status')
    expect(view!.container.querySelector('[data-todo-board-hint]')).toBeNull()
  })

  it('routes a drop between two rows of a priority column to the priority, not to a position', async () => {
    renderBoard([task('a', 'todo', { priority: 'medium' }), task('b', 'todo', { priority: 'urgent' })], 'priority')

    await dropOn(cardOf('b'), 'a')

    expect(service.updates).toEqual([{ id: 'a', patch: { priority: 'urgent' } }])
    expect(service.moves).toEqual([])
  })

  it('keeps a row of a priority column pickable, but never a gap beside it', async () => {
    renderBoard([task('a', 'todo', { priority: 'medium' }), task('b', 'todo', { priority: 'medium' })], 'priority')

    // The half this dimension does answer for: the row is still picked up and dragged to another column.
    expect(cardOf('a').draggable, 'a priority column left the row undraggable').toBe(true)
    expect(cardOf('a').getAttribute('data-todo-draggable')).not.toBeNull()

    await dragOverOn(cardOf('a'), 'b')

    // The half it refuses: a before/after line promises a place inside the column, and a priority
    // column has none to give — so the line a reader would aim at is not drawn at all.
    expect(cardOf('a').querySelector('[data-todo-drop-line]'),
      'the row offered a place inside a column that has none').toBeNull()
  })

  it('still paints the gap line beside a row of a column whose order is the reader\'s', async () => {
    renderBoard([task('a', 'todo'), task('b', 'in_progress')], 'status')

    await dragOverOn(cardOf('b'), 'a')

    // The other dimension keeps both halves: without this case the switch below could be turned off
    // everywhere and the gap a listing does answer for would go missing with it.
    expect(cardOf('b').querySelector('[data-todo-drop-line]'),
      'a column whose order is the reader\'s stopped offering a gap').not.toBeNull()
  })

  it('offers no move up or down for a row of a priority column, while a status column offers them', () => {
    renderBoard([task('a', 'todo', { priority: 'medium' }), task('b', 'todo', { priority: 'medium' })], 'priority')
    openMenu('Task a')
    // A priority column has no hand-written place at either end, so the pair leaves the menu rather than
    // sitting there as two greyed rows that both refuse to do anything.
    const offered = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')]
      .map((node) => (node.textContent ?? '').trim())
    expect(offered).not.toContain(t('todo.move.up'))
    expect(offered).not.toContain(t('todo.move.down'))
    // What the column does answer is still reachable, and the reminder rows are with it.
    expect(offered).toContain(t('todo.move.to_list'))

    // `renderBoard` takes the board — and the menu portal it left on the body — down first.
    renderBoard([task('a', 'todo'), task('b', 'in_progress')], 'status')
    openMenu('Task a')
    expect(menuRow(t('todo.move.down')).disabled).toBe(false)
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
    // The dimension a column stands for is only worth asking once the columns are up.
    expect(view!.container.querySelector('[data-todo-board-group]')).toBeNull()

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

  it('opens the columns a refreshed address names, and cuts them by the dimension it names', () => {
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns&group=list')
    renderList([task('a', 'todo', { listId: 'L1' }), task('b', 'todo', { listId: 'L2' })])

    const board = view!.container.querySelector<HTMLElement>('[data-todo-status-board]')
    expect(board).not.toBeNull()
    expect(board!.getAttribute('data-todo-board-group')).toBe('list')
    expect(view!.container.querySelectorAll('[data-todo-board-column]')).toHaveLength(3)
  })

  it('cuts the columns by status when the address names no dimension', () => {
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns')
    renderList([task('a', 'todo')])

    expect(view!.container.querySelector('[data-todo-status-board]')?.getAttribute('data-todo-board-group')).toBe('status')
  })

  it('writes the chosen dimension into the address, keeping the columns up', async () => {
    stubBreakpoint(true)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns')
    renderList([task('a', 'todo')])

    await chooseGroup(t('todo.layout.group.priority'))

    expect(window.location.search).toBe('?list=work&layout=columns&group=priority')
    expect(view!.container.querySelector('[data-todo-status-board]')?.getAttribute('data-todo-board-group')).toBe('priority')
  })

  it('keeps the plain list when the same address opens on a narrow window', () => {
    stubBreakpoint(false)
    window.history.replaceState(null, '', '/todo?list=work&layout=columns&group=priority')
    renderList([task('a', 'todo')])

    expect(view!.container.querySelector('[data-todo-status-board]')).toBeNull()
    expect(view!.container.querySelector('[data-todo-layout-toggle]')).toBeNull()
    expect(view!.container.querySelector('[data-todo-open]')).not.toBeNull()
  })
})

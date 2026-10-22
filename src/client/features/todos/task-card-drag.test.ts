// @vitest-environment jsdom
/**
 * What a row does with a drag that lands on it.
 *
 * A row has always answered two different questions with one switch: may this card be picked up, and
 * may another card be dropped into the gap beside it. The board cut by priority needs the first and
 * refuses the second — a hand-written place belongs to a list, not to a priority — so one flag came
 * apart into `dragEnabled` (pick this row up) and `reorderEnabled` (aim at the gap beside it). With the
 * second off, the row must neither paint the line nor swallow the drop, because the column behind it is
 * the surface that knows what to do with the row.
 *
 * Each case reads the row's own attributes and the calls its controls recorded. A line that is not
 * drawn is the difference a reader can actually see, which is why it is what is asserted rather than
 * the handler that would have run.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

vi.mock('../../lib/api', () => {
  const counts: TaskCounts = {
    inbox: 0, today: 0, upcoming: 0, overdue: 0, all: 0,
    completed: 0, starred: 0, byList: {}, byTag: {},
  }
  return {
    api: {
      todos: {
        list: async () => ({ tasks: [], total: 0, counts, dayEnd: Date.now() + 3_600_000, timezone: 'UTC' }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        move: async () => ({ task: null }),
        update: async () => ({ task: null, next: null }),
      },
    },
  }
})

import {
  FINE_POINTER_QUERY,
  TaskCard,
  TODO_DRAG_TYPE,
  useTaskMoves,
  type TaskMoveControls,
} from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, extra: Partial<TodoTask> = {}): TodoTask {
  return {
    id,
    title: id,
    description: '',
    status: 'todo',
    priority: 'medium',
    dueAt: null,
    remindAt: null,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    listId: null,
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
    position: 1000,
    ...extra,
  }
}

/** The bag a browser hands a drop target for an in-app drag: our own format, carrying one task id. */
function taskTransfer(draggedId: string): Map<string, string> {
  return new Map([[TODO_DRAG_TYPE, draggedId]])
}

function controls(overrides: Partial<TaskMoveControls> = {}): TaskMoveControls {
  return {
    dragEnabled: true,
    canMoveUp: true,
    canMoveDown: true,
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onMoveToList: vi.fn(),
    onDropBefore: vi.fn(),
    onDropAfter: vi.fn(),
    ...overrides,
  }
}

/** What a browser puts on the events a drop target is handed. */
interface DragLike extends Event {
  dataTransfer: {
    types: string[]
    getData(format: string): string
    setData(format: string, value: string): void
    dropEffect: string
    effectAllowed: string
    files: unknown[]
  }
  clientY: number
  relatedTarget: Node | null
}

const original = useTodos.getState()
let view: RenderedElement | null = null

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  useTodos.setState(original, true)
  // jsdom lays nothing out, so every row measures the same box and `clientY` alone picks the half.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * One row inside a column that also answers drops.
 *
 * The wrapper is the board: a row that refuses a drop is only useful if the surface behind it still
 * gets the event, so the cases below read what the wrapper was handed rather than trusting that the
 * card simply did nothing.
 */
function mount(row: TodoTask, move: TaskMoveControls | undefined, onColumnDrop: () => void): void {
  useTodos.setState({
    status: 'ready',
    tasks: [row],
    completed: [],
    total: 1,
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set<string>(),
  })
  view = renderElement(createElement('div', { onDrop: onColumnDrop }, [
    createElement(TaskCard, {
      key: row.id,
      task: row,
      lists: [],
      bounds: { dayEnd: NOW + DAY, now: NOW },
      timezone: 'UTC',
      onOpen: () => {},
      onStar: () => {},
      ...(move ? { move } : {}),
    }),
  ]))
}

function card(): HTMLElement {
  const node = view!.container.querySelector<HTMLElement>('article')
  expect(node, 'the row is not rendered').toBeTruthy()
  return node!
}

/** One event of a drag, sent at the row with the bag a browser would carry. */
async function sendDrag(type: 'dragover' | 'drop' | 'dragleave', bag: Map<string, string>, clientY: number): Promise<DragLike> {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragLike
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: [...bag.keys()],
        getData: (format: string) => bag.get(format) ?? '',
        setData: (format: string, value: string) => { bag.set(format, value) },
        dropEffect: 'none',
        effectAllowed: 'move',
        files: [],
      },
    },
    clientY: { value: clientY },
    relatedTarget: { value: null },
  })
  await act(async () => {
    card().dispatchEvent(event)
    await Promise.resolve()
  })
  return event
}

/** The pointer arrives with a row in hand: the half of a drag that paints a gap. */
const dragOver = (bag: Map<string, string>, clientY = 20): Promise<DragLike> => sendDrag('dragover', bag, clientY)

/** The pointer lets go over the row: the half that either writes or hands the drop on. */
const dropOn = (bag: Map<string, string>, clientY = 20): Promise<DragLike> => sendDrag('drop', bag, clientY)

/** The pointer leaves without letting go, which has to take the line with it. */
const dragOff = (): Promise<DragLike> => sendDrag('dragleave', new Map(), 20)

/** The line the row paints for the gap it is offering, or null when it offers none. */
function line(row: HTMLElement): string | null {
  const marked = row.querySelector<HTMLElement>('[data-todo-drop-line]')
  if (!marked) return null
  // The line is a mark a pointer reads, never content a screen reader is told about.
  expect(marked.getAttribute('aria-hidden'), 'the insertion line was announced as content').toBe('true')
  return marked.getAttribute('data-todo-drop-line')
}

describe('the two halves of a draggable row', () => {
  it('keeps the row pickable while refusing to be a gap it can drop into', async () => {
    const move = controls({ reorderEnabled: false })
    let columnDrops = 0
    mount(task('a'), move, () => { columnDrops += 1 })

    expect(card().draggable, 'a priority column left the row undraggable').toBe(true)
    expect(card().getAttribute('data-todo-draggable')).not.toBeNull()

    const over = await dragOver(taskTransfer('b'))
    // No line: the promise that dropping here reorders is one this column does not keep.
    expect(line(card()), 'the row painted a place inside a column that has none').toBeNull()
    expect(over.defaultPrevented, 'the row claimed a dragover it cannot answer').toBe(false)

    const drop = await dropOn(taskTransfer('b'))
    expect(drop.defaultPrevented, 'the row swallowed the drop its column owes').toBe(false)
    expect(move.onDropBefore).not.toHaveBeenCalled()
    expect(columnDrops, 'the column behind the row never saw the drop').toBe(1)
  })

  it('still paints the line and takes the drop while both halves are on', async () => {
    const move = controls()
    let columnDrops = 0
    mount(task('a'), move, () => { columnDrops += 1 })

    const over = await dragOver(taskTransfer('b'))
    expect(line(card())).toBe('before')
    expect(over.defaultPrevented, 'a row that reorders left the drop to the browser').toBe(true)
    expect(over.dataTransfer.dropEffect).toBe('move')

    const drop = await dropOn(taskTransfer('b'))
    expect(line(card()), 'the row kept its gap open after the pointer let go').toBeNull()
    expect(drop.defaultPrevented).toBe(true)
    expect(move.onDropBefore).toHaveBeenCalledWith('b')
    expect(columnDrops, 'the row let its drop reach the column behind it').toBe(0)
  })

  it('offers the gap below the row when the pointer is past its middle', async () => {
    const move = controls()
    mount(task('a'), move, () => {})

    await dragOver(taskTransfer('b'), 80)
    expect(line(card())).toBe('after')

    const drop = await dropOn(taskTransfer('b'), 80)
    expect(drop.defaultPrevented).toBe(true)
    expect(move.onDropAfter).toHaveBeenCalledWith('b')
    expect(move.onDropBefore).not.toHaveBeenCalled()
  })

  it('takes the line away when the pointer leaves the row', async () => {
    const move = controls()
    mount(task('a'), move, () => {})

    await dragOver(taskTransfer('b'))
    expect(line(card())).toBe('before')

    await dragOff()
    expect(line(card()), 'the row kept a gap open for a pointer that left').toBeNull()
  })

  it('paints nothing for a pointer that cannot drag at all', async () => {
    const move = controls({ dragEnabled: false })
    mount(task('a'), move, () => {})

    expect(card().draggable).toBe(false)
    expect(card().getAttribute('data-todo-draggable')).toBeNull()

    await dragOver(taskTransfer('b'))
    const drop = await dropOn(taskTransfer('b'))

    expect(line(card())).toBeNull()
    expect(drop.defaultPrevented, 'a row no pointer can drag still swallowed the drop').toBe(false)
    expect(move.onDropBefore).not.toHaveBeenCalled()
  })

  it('writes nothing when a row is dropped onto itself', async () => {
    const move = controls()
    mount(task('a'), move, () => {})

    // A browser hides what a drag carries until the pointer lets go, so the line above is drawn without
    // knowing whose row it is. Only the write can be refused, and only the write matters.
    await dragOver(taskTransfer('a'))
    await dropOn(taskTransfer('a'))

    expect(move.onDropBefore).not.toHaveBeenCalled()
    expect(move.onDropAfter).not.toHaveBeenCalled()
  })

  it('hands on a drag it cannot read', async () => {
    const move = controls()
    let columnDrops = 0
    mount(task('a'), move, () => { columnDrops += 1 })

    // A list row, a note, a file: a format the card cannot read is not its own to swallow, or the
    // surface behind it never learns the pointer let go over it.
    const foreign = new Map([['application/x-inkstone-todo-list', 'L1']])
    await dragOver(foreign)
    const drop = await dropOn(foreign)

    expect(line(card())).toBeNull()
    expect(drop.defaultPrevented).toBe(false)
    expect(move.onDropBefore).not.toHaveBeenCalled()
    expect(columnDrops, 'a foreign drag was eaten by a row that cannot read it').toBe(1)
  })
})

describe('the controls the hook builds', () => {
  /**
   * Answers only the pointer question, so a card cannot read a stub as an invitation.
   *
   * The shared `stubBreakpoint` is deliberately not used here: it judges width queries and answers every
   * other query false, which would make the desktop case below look like a finger.
   */
  function stubPointer(fine: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: fine && query === FINE_POINTER_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
  }

  /** The hook behind a row of the board, read through the card it hands. */
  function Probe({ enabled }: { enabled: boolean }) {
    const moves = useTaskMoves(enabled)
    const row = useTodos((state) => state.tasks)[0]!
    const move = moves(row)
    if (!move) return null
    return createElement(TaskCard, {
      task: row,
      lists: [],
      bounds: { dayEnd: NOW + DAY, now: NOW },
      timezone: 'UTC',
      onOpen: () => {},
      move,
    })
  }

  function mountProbe(enabled: boolean): void {
    useTodos.setState({
      status: 'ready',
      tasks: [task('a', { listId: 'L1' }), task('b', { listId: 'L1' })],
      completed: [],
      lists: [],
      timezone: 'UTC',
      dayEnd: NOW + DAY,
      selectedIds: new Set<string>(),
    })
    view = renderElement(createElement(Probe, { enabled }))
  }

  it('hands both halves to a pointer that can drag, from one query', async () => {
    stubPointer(true)
    mountProbe(true)

    // One spelling of the question, so the board's columns and the row inside them cannot drift apart.
    expect(FINE_POINTER_QUERY, 'the shared query drifted from what a desktop answers')
      .toBe('(hover: hover) and (pointer: fine)')
    expect(card().draggable).toBe(true)
    expect(card().getAttribute('data-todo-draggable')).not.toBeNull()

    // The same pointer that picks the row up is the one that aims at a gap beside it.
    await dragOver(taskTransfer('b'))
    expect(line(card())).toBe('before')
  })

  it('hands neither to a finger, which gets the menu instead', () => {
    stubPointer(false)
    mountProbe(true)

    expect(card().draggable, 'a phone row made itself draggable').toBe(false)
    expect(card().getAttribute('data-todo-draggable')).toBeNull()
  })

  it('hands nothing at all where the order is not the reader\'s', () => {
    stubPointer(true)
    mountProbe(false)

    expect(view!.container.querySelector('article'), 'a disabled listing still drew a row').toBeNull()
  })
})

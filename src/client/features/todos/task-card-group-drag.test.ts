// @vitest-environment jsdom
/**
 * Moving the picked group as one row.
 *
 * A reader who has ticked five rows and dragged one of them means the five, not the one — the bar at
 * the bottom of the screen already speaks for the group, and a gesture that moved only the row under the
 * pointer would be a fifth way to say something the bar says better. So a drag that starts on a picked
 * row carries the whole picked set, in the order the page reads them, and says so on the drag image
 * rather than in a toast afterwards.
 *
 * The landing is the single row's landing with the anchor held: every task is placed *before the same
 * row*, one write after another, because a hand of them fired at once would arrive in whatever order
 * the network chose and the group would land shuffled. And no `listId` patch is smuggled in — that is
 * defect A10, where a row carried its number in the list it was leaving into the middle of the one it
 * was joining.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskCounts, TodoTask } from '@shared/todos/model'

const service = vi.hoisted(() => ({
  rows: [] as TodoTask[],
  moves: [] as { id: string; body: { beforeId: string | null; listId?: string | null } }[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  /** Set by a case that needs one write to wait before the next may be sent. */
  holdId: null as string | null,
  hold: null as Promise<void> | null,
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
          tasks: service.rows,
          total: service.rows.length,
          counts: { ...counts, all: service.rows.length },
          dayEnd: Date.now() + 3_600_000,
          timezone: 'UTC',
        }),
        lists: async () => ({ lists: [] }),
        tags: async () => ({ tags: [] }),
        update: async (id: string, patch: Record<string, unknown>) => {
          service.updates.push({ id, patch })
          return { task: service.rows.find((entry) => entry.id === id)!, next: null }
        },
        move: async (id: string, body: { beforeId: string | null; listId?: string | null }) => {
          service.moves.push({ id, body })
          // One page is re-read after each landed write, so the answer the store reads back is the page
          // with everything up to this one applied.
          if (service.holdId === id && service.hold) await service.hold
          return { task: service.rows.find((entry) => entry.id === id)! }
        },
      },
    },
  }
})

import {
  TODO_DRAG_GROUP_TYPE,
  TODO_DRAG_TYPE,
  TaskCard,
  readTodoTaskDropIds,
  useTaskMoves,
} from './TaskCard'
import { useTodos } from './store'

const NOW = Date.parse('2026-10-20T09:00:00Z')
const DAY = 86_400_000

function task(id: string, listId: string | null = 'L1'): TodoTask {
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
    listId,
    tags: [],
    parentId: null,
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

const original = useTodos.getState()
let view: RenderedElement | null = null

/**
 * The listing a board column is: every open row of one list, in the order the page arrived.
 *
 * The rows are handed the real controls from `useTaskMoves`, because the claim under test is about the
 * requests a drop sends and not about a stub that was told to answer.
 */
function Column() {
  const rows = useTodos((state) => state.tasks)
  const moves = useTaskMoves(true)
  return createElement('div', null, rows.map((row) => {
    const move = moves(row)
    return createElement(TaskCard, {
      key: row.id,
      task: row,
      lists: [],
      bounds: { dayEnd: NOW + DAY, now: NOW },
      timezone: 'UTC',
      onOpen: () => {},
      ...(move ? { move } : {}),
    })
  }))
}

function mount(rows: TodoTask[], picked: string[]): void {
  service.rows = rows
  useTodos.setState({
    status: 'ready',
    tasks: rows,
    completed: [],
    total: rows.length,
    lists: [],
    tags: [],
    timezone: 'UTC',
    dayEnd: NOW + DAY,
    selectedIds: new Set(picked),
  })
  view = renderElement(createElement(Column))
}

beforeEach(async () => {
  localStorage.clear()
  await initI18n()
  service.rows = []
  service.moves.length = 0
  service.updates.length = 0
  service.holdId = null
  service.hold = null
  useTodos.setState(original, true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
})

afterEach(() => {
  act(() => { view?.unmount() })
  view = null
  document.body.innerHTML = ''
  useTodos.setState(original, true)
  vi.restoreAllMocks()
})

function cardOf(id: string): HTMLElement {
  const open = view!.container.querySelector<HTMLElement>(`[data-todo-open="${id}"]`)
  const card = open?.closest('article')
  if (!card) throw new Error(`no card for ${id}`)
  return card as HTMLElement
}

function settle(): Promise<void> {
  return act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release: () => { release() } }
}

/** The bag a browser hands a drag, with the ghost the card hung on it. */
interface Sent {
  bag: Map<string, string>
  ghosts: { node: Node; x: number; y: number }[]
  event: Event
}

async function send(id: string, type: 'dragstart' | 'dragover' | 'drop' | 'dragend', bag = new Map<string, string>(), clientY = 20): Promise<Sent> {
  const ghosts: Sent['ghosts'] = []
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: {
      value: {
        types: [...bag.keys()],
        getData: (format: string) => bag.get(format) ?? '',
        setData: (format: string, value: string) => { bag.set(format, value) },
        dropEffect: 'none',
        effectAllowed: 'unset',
        files: [],
        setDragImage: (node: Node, x: number, y: number) => { ghosts.push({ node, x, y }) },
      },
    },
    clientY: { value: clientY },
    relatedTarget: { value: null },
  })
  await act(async () => {
    cardOf(id).dispatchEvent(event)
    await Promise.resolve()
  })
  return { bag, ghosts, event }
}

function ghostCount(): number {
  return document.querySelectorAll('[data-todo-drag-ghost]').length
}

describe('a drag that starts on a picked row', () => {
  it('carries every picked row of the page, in the order the page reads them', async () => {
    mount([task('a'), task('b'), task('c'), task('d')], ['c', 'a', 'd'])

    const { bag } = await send('a', 'dragstart')

    expect(bag.get(TODO_DRAG_TYPE), 'the drag carried no row of its own').toBe('a')
    expect(JSON.parse(bag.get(TODO_DRAG_GROUP_TYPE) ?? 'null')).toEqual(['a', 'c', 'd'])
    // The row the pointer left is named first, so an anchor-less destination still reads predictably.
  })

  it('shows the count on the drag rather than in the row', async () => {
    mount([task('a'), task('b'), task('c')], ['a', 'b', 'c'])

    const { ghosts } = await send('a', 'dragstart')

    expect(ghosts).toHaveLength(1)
    const node = ghosts[0]!.node as HTMLElement
    expect(node.textContent).toBe(t('todo.drag.move_count', { count: 3 }))
    expect(node.getAttribute('aria-hidden'), 'the drag image was read as content').toBe('true')
    expect(node.isConnected, 'the drag image was never hung where a browser can draw it').toBe(true)
  })

  it('takes the ghost back down when the drag lets go', async () => {
    mount([task('a'), task('b')], ['a', 'b'])

    await send('a', 'dragstart')
    expect(ghostCount()).toBe(1)

    await send('a', 'dragend')
    expect(ghostCount(), 'the ghost outlived the gesture it was drawn for').toBe(0)
  })

  it('drags one row when the row under the pointer was not picked', async () => {
    mount([task('a'), task('b'), task('c')], ['c'])

    const { bag, ghosts } = await send('a', 'dragstart')

    expect(bag.has(TODO_DRAG_GROUP_TYPE), 'an unpicked row dragged a group it is not in').toBe(false)
    expect(bag.get(TODO_DRAG_TYPE)).toBe('a')
    expect(ghosts, 'a single row drew a count for a group of one').toHaveLength(0)
    expect(ghostCount()).toBe(0)
  })

  it('lets a picked row be picked up at all, which the single row used to refuse', () => {
    mount([task('a'), task('b')], ['a', 'b'])

    expect(cardOf('a').draggable, 'a row being picked could not be dragged').toBe(true)
    expect(cardOf('a').getAttribute('data-todo-draggable')).not.toBeNull()
  })
})

describe('a group dropped beside a row', () => {
  it('sends one anchored move per row and never a list patch', async () => {
    mount([task('a'), task('b'), task('c'), task('d')], ['a', 'c'])

    const { bag } = await send('a', 'dragstart')
    await send('d', 'dragover', bag)
    const drop = await send('d', 'drop', bag)
    await settle()

    // The claim in full: a move that names the row each one lands before, and not one `updateTask`
    // smuggling a `listId` — the shape of defect A10.
    expect(service.moves).toEqual([
      { id: 'a', body: { beforeId: 'd' } },
      { id: 'c', body: { beforeId: 'd' } },
    ])
    expect(service.updates, 'a group move wrote a task instead of moving it').toEqual([])
    expect(drop.event.defaultPrevented).toBe(true)
  })

  it('sends them one after another, so the group lands in the order it left', async () => {
    mount([task('a'), task('b'), task('c'), task('d')], ['a', 'b', 'c'])
    const gate = deferred()
    service.holdId = 'a'
    service.hold = gate.promise

    const { bag } = await send('a', 'dragstart')
    await send('d', 'dragover', bag)
    await send('d', 'drop', bag)
    await settle()

    // Nothing after the first write may be sent until the first has landed, or the anchor is reached
    // in whichever order the requests were.
    expect(service.moves.map((entry) => entry.id)).toEqual(['a'])
    gate.release()
    await settle()
    expect(service.moves.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('names the destination list when the group crosses into another one', async () => {
    mount([task('a', 'L1'), task('b', 'L2'), task('c', 'L2')], ['a'])

    const { bag } = await send('a', 'dragstart')
    await send('b', 'dragover', bag)
    await send('b', 'drop', bag)
    await settle()

    // Crossing a list is still an anchored move, and the list it lands in is named beside the anchor —
    // never a bare `listId` patch, which is defect A10.
    expect(service.moves).toEqual([{ id: 'a', body: { beforeId: 'b', listId: 'L2' } }])
    expect(service.updates).toEqual([])
  })

  it('leaves the row it landed on out of the group it moves', async () => {
    mount([task('a'), task('b'), task('c')], ['a', 'b', 'c'])

    const { bag } = await send('a', 'dragstart')
    await send('b', 'dragover', bag)
    await send('b', 'drop', bag)
    await settle()

    // The row under the pointer is the anchor, not a member of what is being carried.
    expect(service.moves.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(service.moves.every((entry) => entry.body.beforeId === 'b')).toBe(true)
  })

  it('reads a single drag as the group of one it is', () => {
    const card = document.createElement('div')
    document.body.appendChild(card)
    const event = new Event('drop')
    const bag = new Map([[TODO_DRAG_TYPE, 'solo']])
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: [...bag.keys()],
        getData: (format: string) => bag.get(format) ?? '',
      },
    })
    expect(readTodoTaskDropIds(event as unknown as React.DragEvent)).toEqual(['solo'])
    card.remove()
  })

  it('falls back to the row it names when the group is not one we wrote', () => {
    const event = new Event('drop')
    const bag = new Map([[TODO_DRAG_TYPE, 'solo'], [TODO_DRAG_GROUP_TYPE, 'not json at all']])
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        types: [...bag.keys()],
        getData: (format: string) => bag.get(format) ?? '',
      },
    })
    expect(readTodoTaskDropIds(event as unknown as React.DragEvent), 'a broken bag lost the row with it').toEqual(['solo'])
  })

  it('answers nothing for a drag that carries no task', () => {
    const event = new Event('drop')
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: [], getData: () => '' },
    })
    expect(readTodoTaskDropIds(event as unknown as React.DragEvent)).toEqual([])
  })
})

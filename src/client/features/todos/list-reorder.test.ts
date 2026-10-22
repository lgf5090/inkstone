// @vitest-environment jsdom
/**
 * Reordering the organizer page's list tree.
 *
 * Two things are pinned here, and they are the two a drag feature usually gets wrong.
 *
 * The first is the arithmetic. `todos_lists.position` is an INTEGER column and the worker truncates
 * what it is given, so the midpoint fold a task row uses would collapse two neighbours onto the same
 * number after one drop into the same gap. The planner therefore renumbers by index instead: the
 * order on screen becomes a strided sequence, and only the rows that actually change hands are
 * written. The cases below drive the sequence around many times to prove no fraction, no collision
 * and no unbounded number ever reaches the route.
 *
 * The second is that the drop the reader aimed at is the drop that happens. The bands, the refusals
 * the one-level grouping forces, and the writes come out of one pure function, so the line painted on
 * a row and the request it sends cannot disagree — and the last group of cases says so through the
 * real store: it drags a row on the page and then reads the order back out of the store, rather than
 * stopping at "a handler exists".
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import type { TaskListEntry } from '../../lib/api'

/** One row of the fake organizer table: exactly the fields the route answers with. */
interface ServerRow {
  id: string
  name: string
  position: number
  parentId: string | null
  archivedAt: number | null
}

const server = vi.hoisted(() => ({
  rows: [] as ServerRow[],
  patches: [] as { id: string; body: Record<string, unknown> }[],
}))

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
      super(message)
    }
  },
  CLIENT_ID: 'test-client',
  api: {
    todos: {
      updateList: async (id: string, body: Record<string, unknown>) => {
        server.patches.push({ id, body })
        const row = server.rows.find((entry) => entry.id === id)
        if (!row) throw new Error(`the drag wrote a list that is not there: ${id}`)
        if (typeof body.position === 'number') row.position = body.position
        if (body.parentId !== undefined) row.parentId = body.parentId as string | null
        return {
          list: { ...row, icon: null, color: null, createdAt: 0, updatedAt: 0, openCount: 0, doneCount: 0 },
        }
      },
    },
  },
}))

import {
  TODO_LIST_DRAG_TYPE,
  ListsView,
  listDropPlacement,
  planListDrop,
  planListMove,
  planListReparent,
} from './ListsView'
import { useTodos } from './store'

/** How far apart the renumbered positions sit, so a later drop has room between any two of them. */
const STRIDE = 1000

function entry(id: string, name: string, extra: Partial<TaskListEntry> = {}): TaskListEntry {
  return {
    id,
    name,
    icon: null,
    color: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    openCount: 0,
    doneCount: 0,
    archivedAt: null,
    parentId: null,
    ...extra,
  }
}

/** The answer the route gives for a working page: flat, in `position` then name order. */
function inOrder(rows: readonly TaskListEntry[]): TaskListEntry[] {
  return [...rows].sort((left, right) =>
    left.position - right.position || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}

/** Applies one plan the way the page does, and hands back the answer the store would now hold. */
function applyPlan(rows: readonly TaskListEntry[], writes: { id: string; position: number; parentId?: string | null }[]): TaskListEntry[] {
  return inOrder(rows.map((row) => {
    const write = writes.find((item) => item.id === row.id)
    if (!write) return row
    return { ...row, position: write.position, ...(write.parentId !== undefined ? { parentId: write.parentId } : {}) }
  }))
}

/**
 * The tree the page draws, read back out of a flat answer: each root, then the lists under it.
 *
 * The view groups rather than sorts, so this is the order a reader actually sees and the only order a
 * test can honestly assert on.
 */
function displayOrder(rows: readonly TaskListEntry[]): string[] {
  const visible = new Set(rows.map((row) => row.id))
  const roots = rows.filter((row) => !row.parentId || !visible.has(row.parentId))
  const out: string[] = []
  for (const root of roots) {
    out.push(root.name)
    for (const child of rows) if (child.parentId === root.id) out.push(child.name)
  }
  return out
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the list drop planner', () => {
  it('renumbers the page when the stored positions sit one apart', () => {
    // A database nobody has reordered yet holds 0,1,2: there is no whole number between any two of
    // them, so the first drop lays the sequence out before it can place anything.
    const lists = inOrder([
      entry('a', 'Alpha', { position: 0 }),
      entry('b', 'Bravo', { position: 1 }),
      entry('c', 'Charlie', { position: 2 }),
    ])
    const writes = planListDrop(lists, 'c', 'a', 'before')
    expect(writes).toEqual([
      { id: 'c', position: STRIDE },
      { id: 'a', position: STRIDE * 2 },
      { id: 'b', position: STRIDE * 3 },
    ])
  })

  it('writes only the rows a move passed over', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('c', 'Charlie', { position: STRIDE * 3 }),
      entry('d', 'Delta', { position: STRIDE * 4 }),
    ])
    // Delta to the second slot: Alpha never moved, so it is never written.
    expect(planListDrop(lists, 'd', 'b', 'before')).toEqual([
      { id: 'd', position: STRIDE * 2 },
      { id: 'b', position: STRIDE * 3 },
      { id: 'c', position: STRIDE * 4 },
    ])
  })

  it('keeps every position a distinct whole number however often the page is rearranged', () => {
    let lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('c', 'Charlie', { position: STRIDE * 3 }),
      entry('d', 'Delta', { position: STRIDE * 4 }),
    ])
    for (let round = 0; round < 12; round += 1) {
      const first = lists[0]!
      const last = lists[lists.length - 1]!
      const writes = planListDrop(lists, last.id, first.id, 'before')
      expect(writes, `round ${round} refused a legal move`).not.toBeNull()
      lists = applyPlan(lists, writes!)
      const positions = lists.map((row) => row.position)
      expect(positions.every(Number.isInteger), `round ${round} wrote a fraction`).toBe(true)
      expect(new Set(positions).size, `round ${round} collided two lists onto one position`).toBe(positions.length)
      // Renumbering by index caps the column at `count * stride`, which is what makes an integer
      // column safe here: the numbers never grow, so they cannot reach anything an INTEGER fears.
      expect(Math.max(...positions), `round ${round} let positions grow past the count`).toBe(lists.length * STRIDE)
      expect(displayOrder(lists)).toEqual([
        last.name,
        ...lists.filter((row) => row.id !== last.id).map((row) => row.name),
      ])
    }
  })

  it('writes one parent change when a drop crosses into a container that already holds the slot', () => {
    const lists = inOrder([
      entry('b', 'Bravo', { position: STRIDE }),
      entry('one', 'One', { position: STRIDE * 2, parentId: 'b' }),
      entry('a', 'Alpha', { position: STRIDE * 3 }),
    ])
    // Alpha sits directly under Bravo's block already, so nothing shifts: the only fact the server
    // needs is that Alpha now belongs to Bravo.
    expect(planListDrop(lists, 'a', 'b', 'inside')).toEqual([
      { id: 'a', position: STRIDE * 3, parentId: 'b' },
    ])
  })

  it('shifts the rows it lands among when the crossing takes a slot', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    ])
    expect(planListDrop(lists, 'a', 'b', 'inside')).toEqual([
      { id: 'b', position: STRIDE },
      { id: 'one', position: STRIDE * 2 },
      { id: 'a', position: STRIDE * 3, parentId: 'b' },
    ])
  })

  it('lifts a child to the top level when it is dropped beside a root', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    ])
    // Alpha kept its slot, so only the two rows the crossing moved are written.
    expect(planListDrop(lists, 'one', 'a', 'after')).toEqual([
      { id: 'one', position: STRIDE * 2, parentId: null },
      { id: 'b', position: STRIDE * 3 },
    ])
  })

  it('refuses to bury a container under another list', () => {
    // The route says a list with its own sub-lists cannot be grouped; a drag that offered it would be
    // an invitation to an error toast.
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
      entry('c', 'Charlie', { position: STRIDE * 4 }),
    ])
    expect(planListDrop(lists, 'b', 'c', 'inside')).toBeNull()
    // A container dropped among another container's children would be a second level.
    expect(planListDrop(lists, 'b', 'one', 'after')).toBeNull()
    // Beside a root it stays a root, which is legal.
    expect(planListDrop(lists, 'b', 'c', 'before')).not.toBeNull()
  })

  it('refuses a container among its own children and a row onto itself', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('one', 'One', { position: STRIDE * 2, parentId: 'a' }),
      entry('b', 'Bravo', { position: STRIDE * 3 }),
    ])
    expect(planListDrop(lists, 'a', 'one', 'before')).toBeNull()
    expect(planListDrop(lists, 'a', 'a', 'after')).toBeNull()
    expect(planListDrop(lists, 'missing', 'a', 'after')).toBeNull()
    expect(planListDrop(lists, 'a', 'missing', 'after')).toBeNull()
  })

  it('refuses a shelf row at either end of the drop', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('old', 'Old', { position: STRIDE * 2, archivedAt: 123 }),
    ])
    expect(planListDrop(lists, 'a', 'old', 'after')).toBeNull()
    expect(planListDrop(lists, 'old', 'a', 'before')).toBeNull()
  })

  it('refuses a middle band on a nested row', () => {
    // One holds nothing, so the band that means "into it" is not one a reader can aim at.
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    ])
    expect(planListDrop(lists, 'a', 'one', 'inside')).toBeNull()
  })

  it('answers an empty plan when the drop lands where the row already sits', () => {
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('c', 'Charlie', { position: STRIDE * 3 }),
    ])
    expect(planListDrop(lists, 'c', 'b', 'after')).toEqual([])
  })
})

describe('the band a pointer falls in', () => {
  it('splits a row that can hold another list into three bands', () => {
    expect(listDropPlacement(0.1, true)).toBe('before')
    expect(listDropPlacement(0.5, true)).toBe('inside')
    expect(listDropPlacement(0.9, true)).toBe('after')
  })

  it('splits a row that can hold nothing into two', () => {
    expect(listDropPlacement(0.1, false)).toBe('before')
    expect(listDropPlacement(0.4, false)).toBe('before')
    expect(listDropPlacement(0.6, false)).toBe('after')
    expect(listDropPlacement(0.9, false)).toBe('after')
  })

  it('reads an unmeasured row as its middle', () => {
    // jsdom lays nothing out, and a real drag over an un-laid-out row asks the same question: the
    // ratio is a half, so the answer is the middle band rather than a NaN comparison.
    expect(listDropPlacement(0.5, true)).toBe('inside')
  })
})

describe('the row menu is the keyboard and phone equivalent of a drag', () => {
  const lists = () => inOrder([
    entry('a', 'Alpha', { position: STRIDE }),
    entry('b', 'Bravo', { position: STRIDE * 2 }),
    entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    entry('two', 'Two', { position: STRIDE * 4, parentId: 'b' }),
  ])

  it('swaps a row with the sibling above it', () => {
    const writes = planListMove(lists(), 'two', 'up')
    expect(writes).not.toBeNull()
    const moved = writes!.find((item) => item.id === 'two')!
    const neighbour = writes!.find((item) => item.id === 'one')!
    expect(moved.position).toBeLessThan(neighbour.position)
    expect(displayOrder(applyPlan(lists(), writes!))).toEqual(['Alpha', 'Bravo', 'Two', 'One'])
  })

  it('has nowhere to go above the first row of its own group', () => {
    // One is Bravo's first child: the row above it on the page is Bravo itself, and moving onto your
    // own container is not "up" — lifting out is what the grouping submenu already does. Bravo, the
    // container, is the second root and so does have a row above it.
    expect(planListMove(lists(), 'one', 'up')).toBeNull()
    expect(planListMove(lists(), 'b', 'up')).not.toBeNull()
    expect(planListMove(lists(), 'a', 'up')).toBeNull()
  })

  it('has nowhere to go below the last row of its own group', () => {
    expect(planListMove(lists(), 'two', 'down')).toBeNull()
    expect(planListMove(lists(), 'a', 'down')).not.toBeNull()
  })
})

describe('the grouping submenu is the same re-lay as a drop', () => {
  const base = () => inOrder([
    entry('a', 'Alpha', { position: STRIDE }),
    entry('b', 'Bravo', { position: STRIDE * 2 }),
    entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    entry('two', 'Two', { position: STRIDE * 4, parentId: 'b' }),
  ])

  it('lands a moved-under list at the end of its new group with whole distinct positions', () => {
    const lists = base()
    const writes = planListReparent(lists, 'a', 'b')
    expect(writes, 'the move into a container was refused').not.toBeNull()
    const after = applyPlan(lists, writes!)
    // The picked group's tail, not the row's old global slot — which is the whole reason a bare
    // `parentId` write is not the move.
    expect(displayOrder(after)).toEqual(['Bravo', 'One', 'Two', 'Alpha'])
    expect(after.find((row) => row.id === 'a')!.parentId).toBe('b')
    const positions = after.map((row) => row.position)
    expect(positions.every(Number.isInteger), `the re-lay wrote ${JSON.stringify(positions)}`).toBe(true)
    expect(new Set(positions).size).toBe(positions.length)
  })

  it('lands a lifted-out list at the end of the top level', () => {
    const lists = base()
    const writes = planListReparent(lists, 'one', null)
    expect(writes, 'the lift to top level was refused').not.toBeNull()
    const after = applyPlan(lists, writes!)
    expect(displayOrder(after)).toEqual(['Alpha', 'Bravo', 'Two', 'One'])
    expect(after.find((row) => row.id === 'one')!.parentId).toBeNull()
    const positions = after.map((row) => row.position)
    expect(positions.every(Number.isInteger), `the re-lay wrote ${JSON.stringify(positions)}`).toBe(true)
    expect(new Set(positions).size).toBe(positions.length)
  })

  it('answers null when the row already sits under the picked parent', () => {
    expect(planListReparent(base(), 'one', 'b')).toBeNull()
    expect(planListReparent(base(), 'a', null)).toBeNull()
    expect(planListReparent(base(), 'missing', 'b')).toBeNull()
  })

  it('refuses a container under another list, exactly as the drop does', () => {
    // Bravo holds One and Two, so picking it as a parent is not an option the page offers and not
    // a plan this function makes.
    expect(planListReparent(base(), 'b', 'a')).toBeNull()
  })

  it('still clears a parent the page never drew when nothing shifts', () => {
    // One reads as top level because `gone` is not on the page, yet the row still carries it.
    // Picking "top level" then changes the stored pointer without moving anybody, so the parent
    // rides on a position write rather than being silently dropped.
    const lists = inOrder([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('one', 'One', { position: STRIDE * 2, parentId: 'gone' }),
    ])
    const writes = planListReparent(lists, 'one', null)
    expect(writes, 'the clear was refused').not.toBeNull()
    const mine = writes!.find((write) => write.id === 'one')!
    expect(mine.parentId).toBeNull()
  })
})

describe('a drag on the organizer page reorders through the store', () => {
  let view: RenderedElement | undefined

  /** The row a list draws. Every row is a button inside its own box, so the parent is the row. */
  function rowOf(name: string): HTMLElement {
    const button = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.action.view_list')} ${name}"]`,
    )
    expect(button, `no row for ${name}`).not.toBeNull()
    return button!.parentElement!
  }

  /** One drag event carrying the bag the row under it will read. */
  async function drag(target: EventTarget, type: string, bag: Map<string, string>, clientY: number) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      dataTransfer: {
        value: {
          types: [...bag.keys()],
          getData: (format: string) => bag.get(format) ?? '',
          setData: (format: string, value: string) => { bag.set(format, value) },
          dropEffect: 'move',
          effectAllowed: 'move',
        },
      },
      clientY: { value: clientY },
      relatedTarget: { value: null },
    })
    await act(async () => {
      target.dispatchEvent(event)
      await Promise.resolve()
    })
  }

  /** Picks a row up and hands back the bag its own `dragstart` filled. */
  async function startDrag(name: string): Promise<Map<string, string>> {
    const bag = new Map<string, string>()
    await drag(rowOf(name), 'dragstart', bag, 50)
    expect(bag.get(TODO_LIST_DRAG_TYPE), 'the row put no list id on the drag').toBeTruthy()
    return bag
  }

  function seedRows(rows: readonly TaskListEntry[]): void {
    server.rows = rows.map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      parentId: row.parentId,
      archivedAt: row.archivedAt,
    }))
    useTodos.setState({ lists: inOrder(rows), archivedLists: [] })
  }

  beforeEach(async () => {
    localStorage.clear()
    await initI18n()
    server.rows = []
    server.patches.length = 0
    useTodos.setState({ loadArchivedLists: async () => {}, tags: [] })
    // jsdom lays nothing out, so every row measures the same box and `clientY` alone picks the band.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100))
  })

  afterEach(() => {
    view?.unmount()
    view = undefined
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    useTodos.setState({ lists: [], archivedLists: [] })
  })

  function render(): void {
    view = renderElement(createElement(ListsView, { onOpen: () => {} }))
  }

  it('leaves the two lists swapped in the store and writes whole positions', async () => {
    seedRows([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
      entry('c', 'Charlie', { position: STRIDE * 4 }),
    ])
    render()
    expect(displayOrder(useTodos.getState().lists)).toEqual(['Alpha', 'Bravo', 'One', 'Charlie'])

    const bag = await startDrag('Charlie')
    expect(rowOf('Charlie').classList.contains('opacity-50')).toBe(true)
    // The pointer sits under the bottom of Alpha, so Charlie takes the second slot of the top level.
    await drag(rowOf('Alpha'), 'dragover', bag, 90)
    expect(rowOf('Alpha').getAttribute('data-list-drop-band')).toBe('after')
    await drag(rowOf('Alpha'), 'drop', bag, 90)
    await settle()

    const positions = server.patches.map((patch) => patch.body.position)
    expect(positions.every((value) => typeof value === 'number' && Number.isInteger(value)),
      `a drag wrote ${JSON.stringify(positions)}`).toBe(true)
    expect(server.patches.find((patch) => patch.id === 'c')!.body).toEqual({ position: STRIDE * 2 })
    // The reachability claim: not that a handler ran, but that the page now reads in the new order.
    expect(displayOrder(useTodos.getState().lists)).toEqual(['Alpha', 'Charlie', 'Bravo', 'One'])
    expect(useTodos.getState().lists.find((row) => row.id === 'c')!.position).toBe(STRIDE * 2)
    // The row in hand is no longer painted as the row in hand once the drop has landed.
    expect(rowOf('Charlie').classList.contains('opacity-50')).toBe(false)
  })

  it('sends one parent change with the positions when a drop crosses a container', async () => {
    seedRows([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
    ])
    render()

    const bag = await startDrag('Alpha')
    // The middle band of a childless root means "into it".
    await drag(rowOf('Bravo'), 'dragover', bag, 50)
    expect(rowOf('Bravo').getAttribute('data-list-drop-band')).toBe('inside')
    await drag(rowOf('Bravo'), 'drop', bag, 50)
    await settle()

    const crossing = server.patches.find((patch) => patch.id === 'a')!
    expect(crossing.body).toEqual({ position: STRIDE * 3, parentId: 'b' })
    const lists = useTodos.getState().lists
    expect(lists.find((row) => row.id === 'a')!.parentId).toBe('b')
    expect(displayOrder(lists)).toEqual(['Bravo', 'One', 'Alpha'])
    // And the tree really nests it, rather than the flat array merely agreeing.
    expect(rowOf('Bravo').closest('li')!.contains(rowOf('Alpha'))).toBe(true)
  })

  it('paints no insertion line where the drop is refused, and writes nothing', async () => {
    seedRows([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
      entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
      entry('c', 'Charlie', { position: STRIDE * 4 }),
    ])
    render()

    // Bravo holds One, so it cannot itself become Charlie's child: the band is never offered.
    const bag = await startDrag('Bravo')
    await drag(rowOf('Charlie'), 'dragover', bag, 50)
    expect(rowOf('Charlie').getAttribute('data-list-drop-band')).toBeNull()
    await drag(rowOf('Charlie'), 'drop', bag, 50)
    await settle()

    expect(server.patches).toEqual([])
    expect(displayOrder(useTodos.getState().lists)).toEqual(['Alpha', 'Bravo', 'One', 'Charlie'])
  })

  it('clears the line and the row in hand when the drag ends elsewhere', async () => {
    seedRows([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
    ])
    render()
    const bag = await startDrag('Bravo')
    await drag(rowOf('Alpha'), 'dragover', bag, 10)
    expect(rowOf('Alpha').getAttribute('data-list-drop-band')).toBe('before')
    await drag(rowOf('Bravo'), 'dragend', bag, 10)
    expect(rowOf('Alpha').getAttribute('data-list-drop-band')).toBeNull()
    expect(rowOf('Bravo').classList.contains('opacity-50')).toBe(false)
    expect(server.patches).toEqual([])
  })

  it('ignores a drag that is not a list', async () => {
    seedRows([
      entry('a', 'Alpha', { position: STRIDE }),
      entry('b', 'Bravo', { position: STRIDE * 2 }),
    ])
    render()
    // A task dragged from another surface speaks its own format; a list row must not read it as one.
    const foreign = new Map([['application/x-inkstone-todo', 'task-1']])
    await drag(rowOf('Alpha'), 'dragover', foreign, 10)
    expect(rowOf('Alpha').getAttribute('data-list-drop-band')).toBeNull()
    await drag(rowOf('Alpha'), 'drop', foreign, 10)
    await settle()
    expect(server.patches).toEqual([])
  })

  it('keeps the archive shelf and the inbox out of the drag', async () => {
    seedRows([entry('a', 'Alpha', { position: STRIDE })])
    useTodos.setState({ archivedLists: [entry('old', 'Old', { position: 0, archivedAt: 123 })] })
    render()

    await act(async () => {
      view!.container.querySelector<HTMLButtonElement>(`button[aria-label="${t('todo.list.archived')}"]`)!
        .click()
      await Promise.resolve()
    })

    expect(rowOf('Alpha').getAttribute('data-todo-draggable')).not.toBeNull()
    expect(rowOf(t('todo.smart.inbox')).getAttribute('data-todo-draggable')).toBeNull()
    const shelf = rowOf('Old')
    expect(shelf.getAttribute('data-todo-draggable')).toBeNull()
    expect(shelf.getAttribute('draggable')).not.toBe('true')

    // A shelf row still refuses a list the reader dropped onto it.
    const bag = new Map([[TODO_LIST_DRAG_TYPE, 'a']])
    await drag(shelf, 'dragover', bag, 50)
    expect(shelf.getAttribute('data-list-drop-band')).toBeNull()
    await drag(shelf, 'drop', bag, 50)
    await settle()
    expect(server.patches).toEqual([])
  })
})

describe('the row menu moves a list without a pointer', () => {
  let view: RenderedElement | undefined
  const writes: { id: string; patch: Record<string, unknown> }[] = []

  function menuRow(label: string): HTMLButtonElement {
    const row = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')]
      .find((entry) => (entry.textContent ?? '').trim() === label)
    if (!row) throw new Error(`no menu row named ${label}`)
    return row
  }

  async function openRowMenu(name: string): Promise<void> {
    const button = view!.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('todo.task.actions')}: ${name}"]`,
    )
    expect(button, `the row for ${name} offers no actions`).not.toBeNull()
    await act(async () => {
      button!.click()
      await Promise.resolve()
    })
  }

  beforeEach(async () => {
    localStorage.clear()
    await initI18n()
    writes.length = 0
    useTodos.setState({
      lists: inOrder([
        entry('a', 'Alpha', { position: STRIDE }),
        entry('b', 'Bravo', { position: STRIDE * 2 }),
        entry('c', 'Charlie', { position: STRIDE * 3 }),
      ]),
      archivedLists: [],
      tags: [],
      loadArchivedLists: async () => {},
      updateList: async (id, patch) => {
        writes.push({ id, patch: patch as Record<string, unknown> })
        return null
      },
    })
    view = renderElement(createElement(ListsView, { onOpen: () => {} }))
  })

  afterEach(() => {
    view?.unmount()
    view = undefined
    document.body.innerHTML = ''
    useTodos.setState({ lists: [], archivedLists: [] })
  })

  it('offers move up and down as real menu items, and writes whole positions', async () => {
    await openRowMenu('Bravo')
    const up = menuRow(t('todo.move.up'))
    const down = menuRow(t('todo.move.down'))
    expect(up.tagName).toBe('BUTTON')
    expect(up.getAttribute('role')).toBe('menuitem')
    expect(up.disabled).toBe(false)
    expect(down.disabled).toBe(false)

    await act(async () => {
      down.click()
      await Promise.resolve()
    })
    // Down swaps Bravo with Charlie: the two rows that passed each other are the only writes.
    expect(writes.map((write) => write.id).sort()).toEqual(['b', 'c'])
    expect(writes.every((write) => Number.isInteger(write.patch.position))).toBe(true)
  })

  it('disables move up on the first row of the page', async () => {
    await openRowMenu('Alpha')
    expect(menuRow(t('todo.move.up')).disabled).toBe(true)
    expect(menuRow(t('todo.move.down')).disabled).toBe(false)
  })

  it('disables move down on the last row of the page', async () => {
    await openRowMenu('Charlie')
    expect(menuRow(t('todo.move.up')).disabled).toBe(false)
    expect(menuRow(t('todo.move.down')).disabled).toBe(true)
  })

  it('keeps a nested row inside its own group', async () => {
    await act(async () => {
      useTodos.setState({
        lists: inOrder([
          entry('a', 'Alpha', { position: STRIDE }),
          entry('one', 'One', { position: STRIDE * 2, parentId: 'a' }),
          entry('two', 'Two', { position: STRIDE * 3, parentId: 'a' }),
        ]),
      })
    })
    await openRowMenu('One')
    expect(menuRow(t('todo.move.up')).disabled).toBe(true)
    expect(menuRow(t('todo.move.down')).disabled).toBe(false)
  })

  it('re-lays the whole page when the grouping submenu picks a new parent', async () => {
    await act(async () => {
      useTodos.setState({
        lists: inOrder([
          entry('a', 'Alpha', { position: STRIDE }),
          entry('b', 'Bravo', { position: STRIDE * 2 }),
          entry('one', 'One', { position: STRIDE * 3, parentId: 'b' }),
        ]),
      })
    })
    await openRowMenu('Alpha')
    const parentRow = menuRow(t('todo.list.parent_label'))
    // `mouseover` is what React reads for an enter, and a touch pointer opens the flyout the same
    // way a hover does — the submenu is the phone's only path into a group.
    await act(async () => {
      parentRow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await Promise.resolve()
    })
    const target = [...document.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')]
      .find((node) => (node.textContent ?? '').trim() === 'Bravo')
    expect(target, 'the grouping submenu lists no Bravo').toBeTruthy()
    await act(async () => {
      target!.click()
      await Promise.resolve()
    })

    // Not just the pointer: every row the crossing passed over is written, and Alpha lands at the
    // end of Bravo's group with whole positions throughout.
    const byId = new Map(writes.map((write) => [write.id, write.patch]))
    expect([...byId.keys()].sort()).toEqual(['a', 'b', 'one'])
    expect(byId.get('a')).toEqual({ position: STRIDE * 3, parentId: 'b' })
    expect(byId.get('b')).toEqual({ position: STRIDE })
    expect(byId.get('one')).toEqual({ position: STRIDE * 2 })
    expect([...byId.values()].every((patch) => Number.isInteger(patch.position)),
      JSON.stringify([...byId.values()])).toBe(true)
  })
})

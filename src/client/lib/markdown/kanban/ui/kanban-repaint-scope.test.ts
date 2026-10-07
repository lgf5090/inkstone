/**
 * A card is a `memo` component, and what that buys is this: a change to the board that no card's own
 * props depend on must not repaint the cards. The writers a view hands its rows are part of that
 * contract — a closure rebuilt on every render makes every card's props new, so a click that only
 * opened one card's detail panel repainted the whole board, and a table cell's own edit repainted
 * every other row (K-19).
 *
 * What is pinned here is therefore two halves of one thing: the repaint a board-level click causes,
 * read off the real cards rather than off a stub, and the identity of the writers underneath it. A
 * later change that reads the document out of the render instead of out of the commit is the shape
 * this catches: it works, it just repaints everything to do it.
 */
import { act, createElement, memo, useRef, useState } from 'react'
import { beforeEach, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData, KanbanSubtask } from '../types'
import { KanbanRoot } from './kanban-root'
import { useKanbanRootState } from './kanban-root-hooks'

// Every repaint of a card goes through this wrapper, because the board renders the module's own
// export; the real card is still what renders, so the board behaves exactly as it ships. The wrapper
// is itself memoized, so the count below is reached only when the props a card was handed actually
// changed — which is the whole question, since React offers no way to ask a component whether it ran.
const painted = vi.hoisted(() => [] as string[])

vi.mock('./kanban-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kanban-card')>()
  return {
    ...actual,
    KanbanCard: memo((props: Parameters<typeof actual.KanbanCard>[0]) => {
      painted.push(props.item.id)
      return createElement(actual.KanbanCard, props)
    }),
  }
})

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  painted.length = 0
})

function board(): KanbanData {
  return {
    title: 'Gate Board',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      { id: 'status', name: 'Status', type: 'select', options: [{ id: 'todo', label: 'To Do', color: 'gray' }] },
      { id: 'notes', name: 'Notes', type: 'text' },
    ],
    items: [
      { id: 'a', title: 'A', properties: { status: 'todo', notes: 'first' } },
      { id: 'b', title: 'B', properties: { status: 'todo' } },
      { id: 'c', title: 'C', properties: { status: 'todo' } },
    ],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
  }
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('what a board-level click repaints', () => {
  const mounted: ReturnType<typeof renderElement>[] = []

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()!.unmount()
  })

  function mount(data: KanbanData = board()) {
    const onUpdateData = vi.fn()
    const rendered = renderElement(createElement(KanbanRoot, { initialData: data, onUpdateData }))
    mounted.push(rendered)
    return { ...rendered, onUpdateData }
  }

  it('paints each card once when the board mounts', () => {
    mount()
    expect(painted).toEqual(['a', 'b', 'c'])
  })

  it('repaints nothing when one card opens its detail panel', () => {
    const { container, onUpdateData } = mount()
    painted.length = 0
    click(container.querySelector('[data-item-id="a"]')!)
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(painted).toEqual([])
  })

  it('repaints only the card whose own state changed', () => {
    const { container, onUpdateData } = mount()
    const checkbox = container.querySelector<HTMLInputElement>('[data-item-id="b"] input[type="checkbox"]')
    if (!checkbox) throw new Error('the card offers no selection control to press')
    painted.length = 0
    click(checkbox)
    expect(onUpdateData).not.toHaveBeenCalled()
    expect(checkbox.checked).toBe(true)
    // The two cards whose own props did not move keep their last paint.
    expect(painted).toEqual(['b'])
  })
})

/** The board's own state, watched across renders: a probe that keeps the latest one and can be told
 * to render again without the document changing. */
const probes: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (probes.length > 0) probes.pop()!.unmount()
})

function mountProbe(data: KanbanData = board()) {
  const holder = {
    state: null as unknown as ReturnType<typeof useKanbanRootState>,
    rerender: () => {},
  }
  const onUpdateData = vi.fn()

  function Probe() {
    const containerRef = useRef<HTMLElement | null>(null)
    const [, bump] = useState(0)
    holder.state = useKanbanRootState(data, onUpdateData, containerRef)
    holder.rerender = () => bump((n) => n + 1)
    return createElement('div', { ref: containerRef })
  }

  probes.push(renderElement(createElement(Probe)))
  return { holder, onUpdateData }
}

/**
 * The writers a view hands its rows: a board-level render — the kind a detail panel, a menu or a
 * toast causes — has to leave their identity alone, because that identity is what the memos below
 * them compare.
 */
describe('the writers a view hands down', () => {
  const mount = mountProbe

  it('keeps one identity across a render the document did not ask for', () => {
    const { holder } = mount()
    const writers = {
      subtasks: holder.state.items.handleUpdateSubtasks,
      property: holder.state.items.handleUpdateProperty,
      item: holder.state.items.handleUpdateItem,
    }
    act(() => { holder.rerender() })
    expect(holder.state.items.handleUpdateSubtasks).toBe(writers.subtasks)
    expect(holder.state.items.handleUpdateProperty).toBe(writers.property)
    expect(holder.state.items.handleUpdateItem).toBe(writers.item)
  })
})

// What those writers commit, so a stable identity never becomes a silent behaviour change.
describe('what the board’s writers commit', () => {
  const mount = mountProbe

  it('writes one item’s subtasks and leaves every other field in the document alone', () => {
    const { holder, onUpdateData } = mount()
    const subtasks: KanbanSubtask[] = [{ id: 's1', title: 'Read it', completed: false }]
    act(() => { holder.state.items.handleUpdateSubtasks('a', subtasks) })
    const next = onUpdateData.mock.calls.at(-1)![0] as KanbanData
    expect(next.items.find((item) => item.id === 'a')!.subtasks).toEqual(subtasks)
    expect(next.items.find((item) => item.id === 'a')!.properties).toEqual(board().items[0]!.properties)
    expect(next.items.filter((item) => item.id !== 'a')).toEqual(board().items.slice(1))
  })

  it('writes one property of one item, and keeps the item’s other properties', () => {
    const { holder, onUpdateData } = mount()
    act(() => { holder.state.items.handleUpdateProperty('a', 'notes', 'second') })
    const next = onUpdateData.mock.calls.at(-1)![0] as KanbanData
    expect(next.items[0]!.properties).toEqual({ status: 'todo', notes: 'second' })
    expect(next.items[1]!.properties).toEqual({ status: 'todo' })
  })
})

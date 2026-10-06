/**
 * A column is a `memo` component, and what that buys the board is this: a drag that lights up one
 * column must not repaint the others. Nothing was collecting on it. The board handed every column the
 * drag bundle `useKanbanBoardDndState` returned — a fresh object per render, with a fresh
 * `isDragOverCell` inside it — so the comparison found new props every time and the `memo` never got
 * to answer; K-19 stopped the same leak one layer down, at the cards.
 *
 * What is counted here is the column's own render pass, read off the real header (the wrapper is a
 * plain component, not a `memo`, so it is recorded whenever its column renders rather than whenever
 * its own props moved): if a column bails out, nothing inside it runs. The three scenarios are the
 * ones the fix is for — the drag state itself, the highlight landing, and the highlight moving on —
 * because a stable bundle can be bought at the price of a highlight that never reaches the column.
 */
import { act, createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { installTestGlobals, renderElement } from '../../../test-render'
import type { KanbanData } from '../types'
import { KanbanBoardView } from './kanban-board-view'

const painted = vi.hoisted(() => [] as string[])

vi.mock('./kanban-column-header', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kanban-column-header')>()
  return {
    ...actual,
    KanbanColumnHeader: (props: Parameters<typeof actual.KanbanColumnHeader>[0]) => {
      painted.push(props.groupKey)
      return createElement(actual.KanbanColumnHeader, props)
    },
  }
})

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

const mounted: ReturnType<typeof renderElement>[] = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount()
  painted.length = 0
})

function board(): KanbanData {
  return {
    title: 'Gate Board',
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'todo', label: 'To Do', color: 'gray' },
          { id: 'doing', label: 'In Progress', color: 'blue' },
          { id: 'done', label: 'Done', color: 'green' },
        ],
      },
    ],
    items: [
      { id: 'a', title: 'A', properties: { status: 'todo' } },
      { id: 'b', title: 'B', properties: { status: 'doing' } },
      { id: 'c', title: 'C', properties: { status: 'done' } },
    ],
    views: [{ id: 'v', name: 'Board', type: 'board', groupBy: 'status' }],
  }
}

/** The board's own callbacks, one identity for the tree's life: only the drag bundle is under test. */
const noop = vi.fn()

function boardElement(data: KanbanData, selected: string[]) {
  return createElement(KanbanBoardView, {
    data,
    view: data.views[0]!,
    selectedIds: new Set(selected),
    onToggleSelect: noop,
    onToggleAll: noop,
    onOpenDetail: noop,
    onToggleTag: noop,
    onUpdateTitle: noop,
    onUpdateSubtasks: noop,
    onMoveItem: noop,
    onAddItem: noop,
    onAddColumn: noop,
    onReorderColumns: noop,
    onUpdateColumn: noop,
    onDeleteColumn: noop,
    onUpdateTags: noop,
    onAddColumnOption: noop,
  })
}

function mountBoard(selected: string[] = []) {
  const rendered = renderElement(boardElement(board(), selected))
  mounted.push(rendered)
  return rendered.container
}

function columnOf(container: HTMLElement, groupKey: string): Element {
  const column = container.querySelector(`[data-kanban-group="${groupKey}"]`)
  if (!column) throw new Error(`the board drew no column for ${groupKey}`)
  return column
}

/** A drag-over is what lights a column up; the handler itself reads nothing off the event. */
function hoverColumn(container: HTMLElement, groupKey: string): void {
  act(() => {
    columnOf(container, groupKey).dispatchEvent(new Event('dragover', { bubbles: true }))
  })
}

/** Starting a drag moves the board's own state without moving any column's props. */
function startDraggingCard(container: HTMLElement, itemId: string): void {
  const card = container.querySelector(`[data-item-id="${itemId}"]`)
  if (!card) throw new Error(`the board drew no card for ${itemId}`)
  act(() => {
    const event = new Event('dragstart', { bubbles: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: () => {}, getData: () => '', effectAllowed: 'move', dropEffect: 'move' },
    })
    card.dispatchEvent(event)
  })
}

describe('a drag repaints the column it landed on and no other', () => {
  it('paints every column once when the board mounts', () => {
    mountBoard()
    expect(painted).toEqual(['todo', 'doing', 'done'])
  })

  it('paints only the column the highlight landed on', () => {
    const container = mountBoard()
    painted.length = 0
    hoverColumn(container, 'doing')
    expect(painted).toEqual(['doing'])
  })

  it('paints the column that lost the highlight and the one that gained it', () => {
    const container = mountBoard()
    hoverColumn(container, 'doing')
    painted.length = 0
    hoverColumn(container, 'done')
    expect(painted).toEqual(['doing', 'done'])
  })

  it('paints nothing when the pointer reports the same column again', () => {
    const container = mountBoard()
    hoverColumn(container, 'doing')
    painted.length = 0
    hoverColumn(container, 'doing')
    expect(painted).toEqual([])
  })

  it('paints nothing when a card is picked up, which moves no column', () => {
    const container = mountBoard()
    painted.length = 0
    startDraggingCard(container, 'a')
    expect(painted).toEqual([])
  })
})

/**
 * Picking a card is the other gesture that must not reach past the column it happened in.
 *
 * The selection is one set for the whole board and a new one every time anything is ticked, so the
 * column was handed a fresh `selectedIds` — and a fresh `selectAll` bundle built on it — for a tick
 * that touched one card of one column. A banded board multiplies that by every band.
 */
describe('a ticked card repaints the column that holds it and no other', () => {
  it('paints only that column when one of its cards is picked', () => {
    const data = board()
    const rendered = renderElement(boardElement(data, []))
    mounted.push(rendered)
    painted.length = 0

    // What the board does when the reader ticks 'a', a card of the To Do column.
    rendered.rerender(boardElement(data, ['a']))
    expect(painted, 'a tick in one column repainted the others').toEqual(['todo'])
  })

  it('still paints the picked card as picked, in the column it belongs to', () => {
    const container = mountBoard(['a'])
    const card = container.querySelector<HTMLElement>('[data-item-id="a"]')
    if (!card) throw new Error('the board drew no card for a')
    const box = card.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(box?.checked, 'the card the reader picked was not drawn as picked').toBe(true)
  })
})

describe('the highlight still reaches the column it is over', () => {
  it('marks the hovered column and leaves the others unmarked', () => {
    const container = mountBoard()
    hoverColumn(container, 'doing')
    expect(columnOf(container, 'doing').className).toContain('--accent-softer')
    expect(columnOf(container, 'todo').className).not.toContain('--accent-softer')
  })

  it('clears the mark when the highlight moves on', () => {
    const container = mountBoard()
    hoverColumn(container, 'doing')
    hoverColumn(container, 'done')
    expect(columnOf(container, 'doing').className).not.toContain('--accent-softer')
    expect(columnOf(container, 'done').className).toContain('--accent-softer')
  })
})

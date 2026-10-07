/**
 * KU-22. What the wiring hands the drag is what decides between a batch move and a single one: the
 * board passes its batch writer on only when the host has one, so a host that gathers cards without
 * being able to write a batch still gets the card the reader held moved rather than a swallowed drop.
 *
 * The drag's own trust checks are `kanban-board-dnd.test.ts`'s subject; what is asserted here is only
 * who a drop ends up at once the batch and the selection are known.
 */
import { act, createElement } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../../../../lib/i18n'
import { renderElement } from '../../../test-render'
import { useBoardDrag, type BoardBatch } from './kanban-board-wiring'
import type { KanbanBoardCell } from '../swimlane'
import type { KanbanData, KanbanView } from '../types'

beforeAll(async () => {
  await initI18n()
})

const VIEW: KanbanView = { id: 'v-board', name: 'Board', type: 'board', groupBy: 'status' }

function board(): KanbanData {
  return {
    columns: [
      { id: 'title', name: 'Title', type: 'title' },
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [
          { id: 'todo', label: 'To Do', color: 'gray' },
          { id: 'doing', label: 'Doing', color: 'blue' },
        ],
      },
    ],
    items: [
      { id: 'a', title: 'Card a', properties: { status: 'todo' } },
      { id: 'b', title: 'Card b', properties: { status: 'todo' } },
    ],
    views: [VIEW],
  }
}

function fakeDragEvent(currentTarget: Element, values: Record<string, string>) {
  return {
    currentTarget,
    clientY: 0,
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: {
      getData: (format: string) => values[format] ?? '',
      setData: () => {},
      dropEffect: 'move',
      effectAllowed: 'move',
    },
  } as unknown as React.DragEvent
}

/** The board element a drop resolves its card against: only its protocol is read, never its layout. */
function boardDom(cardIds: string[]) {
  const board = document.createElement('div')
  board.setAttribute('data-kanban-board', '')
  for (const id of cardIds) {
    const card = document.createElement('div')
    card.setAttribute('data-item-id', id)
    board.appendChild(card)
  }
  document.body.appendChild(board)
  return { board, cleanup: () => board.remove() }
}

function renderBoardDrag(onMoveItem: (itemId: string, cell: KanbanBoardCell) => void, batch: BoardBatch) {
  let api: ReturnType<typeof useBoardDrag> | null = null
  function Probe() {
    api = useBoardDrag(board(), VIEW, onMoveItem, batch)
    return null
  }
  const rendered = renderElement(createElement(Probe))
  if (!api) throw new Error('probe did not expose the board wiring')
  return { api: api as ReturnType<typeof useBoardDrag>, unmount: rendered.unmount }
}

const doing: KanbanBoardCell = { groupKey: 'doing' }

describe('a drop made on a board that gathers cards', () => {
  it('moves the held card alone when the host hands no batch writer', () => {
    const dom = boardDom(['a'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderBoardDrag(onMoveItem, { selectedIds: new Set(['a', 'b']) })
    try {
      act(() => {
        api.dnd.handleCardDragStart(fakeDragEvent(dom.board, {}), 'a', 'todo')
      })
      act(() => {
        api.dnd.handleCardDrop(fakeDragEvent(dom.board, { 'text/plain': 'a' }), doing, 'a')
      })
      expect(onMoveItem).toHaveBeenCalledWith('a', doing, { itemId: 'a', position: 'before' })
    } finally {
      unmount()
      dom.cleanup()
    }
  })

  it('hands the same drop to the batch writer when the host has one', () => {
    const dom = boardDom(['a'])
    const onMoveItem = vi.fn()
    const moveSelection = vi.fn()
    const { api, unmount } = renderBoardDrag(onMoveItem, { selectedIds: new Set(['a', 'b']), moveSelection })
    try {
      act(() => {
        api.dnd.handleCardDragStart(fakeDragEvent(dom.board, {}), 'a', 'todo')
      })
      act(() => {
        api.dnd.handleCardDrop(fakeDragEvent(dom.board, { 'text/plain': 'a' }), doing, 'a')
      })
      expect(moveSelection).toHaveBeenCalledWith('a', doing, { itemId: 'a', position: 'before' })
      expect(onMoveItem).not.toHaveBeenCalled()
    } finally {
      unmount()
      dom.cleanup()
    }
  })
})

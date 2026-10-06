import { act, createElement, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderElement } from '../../../test-render'
import { useKanbanBoardDndState } from './kanban-board-dnd'
import type { KanbanMovePivot } from '../dnd'
import type { KanbanBoardCell } from '../swimlane'

function fakeDataTransfer(values: Record<string, string>) {
  return {
    getData: (format: string) => values[format] ?? '',
    setData: () => {},
    dropEffect: 'move',
    effectAllowed: 'move',
  }
}

function fakeDragEvent(currentTarget: Element, values: Record<string, string>, clientY = 0) {
  return {
    currentTarget,
    clientY,
    preventDefault: () => {},
    stopPropagation: () => {},
    dataTransfer: fakeDataTransfer(values),
  } as unknown as React.DragEvent
}

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

function renderDndHook(onMoveItem: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void) {
  let api: ReturnType<typeof useKanbanBoardDndState> | null = null
  function Probe() {
    api = useKanbanBoardDndState(onMoveItem)
    return null
  }
  const rendered = renderElement(createElement(Probe))
  if (!api) throw new Error('probe did not expose the dnd api')
  return { api: api as ReturnType<typeof useKanbanBoardDndState>, unmount: rendered.unmount }
}

const todoCell: KanbanBoardCell = { groupKey: 'todo' }

describe('kanban board drop trust check for external drops', () => {
  it('ignores a text/plain drop whose value matches no card on this board', () => {
    const board = boardDom(['real-card'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    try {
      act(() => {
        api.handleColumnDrop(fakeDragEvent(board.board, { 'text/plain': 'external-file-name.md' }), todoCell)
      })
      expect(onMoveItem).not.toHaveBeenCalled()
    } finally {
      unmount()
      board.cleanup()
    }
  })

  it('ignores a dropped id that only exists on another kanban board in the document', () => {
    const here = boardDom(['local-card'])
    const there = boardDom(['other-board-card'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    try {
      act(() => {
        api.handleColumnDrop(fakeDragEvent(here.board, { 'text/plain': 'other-board-card' }), todoCell)
      })
      expect(onMoveItem).not.toHaveBeenCalled()
    } finally {
      unmount()
      here.cleanup()
      there.cleanup()
    }
  })

  it('card drop ignores an external text drop even when a same-id card exists elsewhere', () => {
    const here = boardDom(['local-card'])
    const there = boardDom(['shared-id'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    try {
      act(() => {
        api.handleCardDrop(fakeDragEvent(here.board, { 'text/plain': 'shared-id' }), todoCell, 'local-card')
      })
      expect(onMoveItem).not.toHaveBeenCalled()
    } finally {
      unmount()
      here.cleanup()
      there.cleanup()
    }
  })
})

describe('kanban board drop trust check for internal drags', () => {
  it('moves a card dragged by the board protocol when its element is on this board', () => {
    const board = boardDom(['real-card'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    try {
      const payload = JSON.stringify({ type: 'card', itemId: 'real-card', sourceGroupKey: 'doing' })
      act(() => {
        api.handleColumnDrop(
          fakeDragEvent(board.board, { 'application/json': payload, 'text/plain': 'real-card' }),
          todoCell,
        )
      })
      expect(onMoveItem).toHaveBeenCalledWith('real-card', todoCell)
    } finally {
      unmount()
      board.cleanup()
    }
  })

  it('card drop keeps working for an in-flight internal drag even after data is gone', () => {
    const board = boardDom(['real-card'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    try {
      const startEvent = fakeDragEvent(board.board, {})
      act(() => {
        api.handleCardDragStart(startEvent, 'real-card', 'todo')
      })
      const payload = JSON.stringify({ type: 'card', itemId: 'real-card', sourceGroupKey: 'todo' })
      act(() => {
        api.handleCardDrop(fakeDragEvent(board.board, { 'application/json': payload }), todoCell, 'real-card')
      })
      expect(onMoveItem).toHaveBeenCalledWith('real-card', todoCell, { itemId: 'real-card', position: 'before' })
    } finally {
      unmount()
      board.cleanup()
    }
  })
})

describe('useKanbanBoardDndState handler stability', () => {
  it('keeps every handler identity across re-renders even when the move callback changes', () => {
    const snapshots: ReturnType<typeof useKanbanBoardDndState>[] = []
    function Probe() {
      const [tick, setTick] = useState(0)
      // a fresh arrow each render, like an unmemoized parent prop
      snapshots.push(useKanbanBoardDndState(((_id: string, _cell: KanbanBoardCell, _pivot?: KanbanMovePivot) => {})))
      if (tick < 3) setTick((n) => n + 1)
      return null
    }
    const rendered = renderElement(createElement(Probe))
    rendered.unmount()
    expect(snapshots.length).toBeGreaterThan(1)
    const first = snapshots[0]!
    for (const snap of snapshots.slice(1)) {
      expect(snap.handleCardDragStart).toBe(first.handleCardDragStart)
      expect(snap.handleColumnDragStart).toBe(first.handleColumnDragStart)
      expect(snap.handleCardDragOver).toBe(first.handleCardDragOver)
      expect(snap.handleCardDrop).toBe(first.handleCardDrop)
      expect(snap.handleColumnDrop).toBe(first.handleColumnDrop)
      expect(snap.handleDragEnd).toBe(first.handleDragEnd)
    }
  })

  it('still routes a drop to the move callback from the latest render', () => {
    const board = boardDom(['real-card'])
    const moves: string[][] = []
    const holder: { api: ReturnType<typeof useKanbanBoardDndState> | null } = { api: null }
    function Probe() {
      const [tick, setTick] = useState(0)
      holder.api = useKanbanBoardDndState((itemId: string) => { moves.push([itemId, String(tick)]) })
      if (tick < 2) setTick((n) => n + 1)
      return null
    }
    const rendered = renderElement(createElement(Probe))
    try {
      const payload = JSON.stringify({ type: 'card', itemId: 'real-card', sourceGroupKey: 'todo' })
      act(() => {
        holder.api!.handleColumnDrop(fakeDragEvent(board.board, { 'application/json': payload }), { groupKey: 'doing' })
      })
      expect(moves).toEqual([['real-card', '2']])
    } finally {
      rendered.unmount()
      board.cleanup()
    }
  })
})

describe('the cell a drag is over', () => {
  it('lights one cell of a column rather than every band that column is drawn in', () => {
    const holder: { api: ReturnType<typeof useKanbanBoardDndState> | null } = { api: null }
    function Probe() {
      holder.api = useKanbanBoardDndState(() => {})
      return null
    }
    const rendered = renderElement(createElement(Probe))
    try {
      act(() => { holder.api!.setDragOverCell({ groupKey: 'todo', laneKey: 'alice' }) })
      expect(holder.api!.isDragOverCell({ groupKey: 'todo', laneKey: 'alice' })).toBe(true)
      expect(holder.api!.isDragOverCell({ groupKey: 'todo', laneKey: 'bob' })).toBe(false)
      expect(holder.api!.isDragOverCell({ groupKey: 'todo' })).toBe(false)
    } finally {
      rendered.unmount()
    }
  })

  it('carries the band of the cell a card was dropped into to the writer', () => {
    const board = boardDom(['real-card'])
    const onMoveItem = vi.fn()
    const { api, unmount } = renderDndHook(onMoveItem)
    const bandedCell: KanbanBoardCell = { groupKey: 'todo', laneKey: 'bob' }
    try {
      const payload = JSON.stringify({ type: 'card', itemId: 'real-card', sourceGroupKey: 'doing' })
      act(() => {
        api.handleColumnDrop(fakeDragEvent(board.board, { 'application/json': payload }), bandedCell)
      })
      expect(onMoveItem).toHaveBeenCalledWith('real-card', bandedCell)
    } finally {
      unmount()
      board.cleanup()
    }
  })
})

describe('useKanbanBoardDndState dragover bail', () => {
  it('keeps the drop-target identity for a frame repeating the same card and position, and updates on either change', () => {
    const holder: { api: ReturnType<typeof useKanbanBoardDndState> | null } = { api: null }
    function Probe() {
      holder.api = useKanbanBoardDndState(() => {})
      return null
    }
    const rendered = renderElement(createElement(Probe))
    const card = document.createElement('div')
    const rectSpy = vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 } as DOMRect)
    try {
      act(() => { holder.api!.handleCardDragOver(fakeDragEvent(card, {}, 10), 'card-1') })
      expect(holder.api!.cardDropTarget).toEqual({ cardId: 'card-1', position: 'top' })
      const first = holder.api!.cardDropTarget
      act(() => { holder.api!.handleCardDragOver(fakeDragEvent(card, {}, 12), 'card-1') })
      expect(holder.api!.cardDropTarget).toBe(first)
      act(() => { holder.api!.handleCardDragOver(fakeDragEvent(card, {}, 80), 'card-1') })
      expect(holder.api!.cardDropTarget).toEqual({ cardId: 'card-1', position: 'bottom' })
      act(() => { holder.api!.handleCardDragOver(fakeDragEvent(card, {}, 80), 'card-2') })
      expect(holder.api!.cardDropTarget).toEqual({ cardId: 'card-2', position: 'bottom' })
    } finally {
      rectSpy.mockRestore()
      rendered.unmount()
    }
  })
})

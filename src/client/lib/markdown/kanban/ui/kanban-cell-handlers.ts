import { useMemo } from 'react'
import type { KanbanAddFinish, KanbanColorName, KanbanColumnPatch } from '../types'
import type { KanbanBoardCell } from '../swimlane'
import type { CardMoveDirection } from './kanban-card'
import type { useKanbanBoardDndState } from './kanban-board-dnd'

type CellDnd = ReturnType<typeof useKanbanBoardDndState>

export interface ColumnCellHandlerDeps {
  cell: KanbanBoardCell
  /** The key of the group this cell belongs to, which is what its own edits name. */
  groupKey: string
  dnd: CellDnd
  onUpdateColumn?: (groupKey: string, patch: KanbanColumnPatch) => void
  onDeleteColumn?: (groupKey: string) => void
  onAddItem: (cell: KanbanBoardCell, finish?: KanbanAddFinish) => void
  onMoveCell: (itemId: string, cell: KanbanBoardCell, dir: CardMoveDirection) => void
}

/**
 * The handlers a column hands its cards, rebuilt only when something they actually read changes.
 * They are what the cards below compare, so a closure minted per render would make every card's props
 * new and repaint the whole column for a change to one of them (K-19).
 *
 * The cell is rebuilt from its two keys rather than kept from the render, because the board hands
 * each cell a fresh object every time, and the card id is never captured: the card passes its own id
 * to the handler that takes one, which is what keeps a single handler usable by all of them.
 */
export function useColumnCellHandlers(deps: ColumnCellHandlerDeps) {
  const { cell, groupKey, dnd, onUpdateColumn, onDeleteColumn, onAddItem, onMoveCell } = deps
  const { groupKey: cellGroupKey, laneKey } = cell
  const setDragOverCell = dnd.setDragOverCell
  const handleColumnDrop = dnd.handleColumnDrop
  const handleCardDrop = dnd.handleCardDrop
  const handleCardDragStart = dnd.handleCardDragStart
  const handleColumnDragStart = dnd.handleColumnDragStart
  return useMemo(() => {
    const target: KanbanBoardCell = { groupKey: cellGroupKey, laneKey }
    return {
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault()
        setDragOverCell(target)
      },
      onDrop: (e: React.DragEvent) => handleColumnDrop(e, target),
      onDragStartCard: (e: React.DragEvent, id: string) => handleCardDragStart(e, id, groupKey),
      onDropCard: (e: React.DragEvent, id: string) => handleCardDrop(e, target, id),
      onDragStartColumn: (e: React.DragEvent) => handleColumnDragStart(e, groupKey),
      onRenameColumn: (newLabel: string) => onUpdateColumn?.(groupKey, { label: newLabel }),
      onChangeColumnColor: (newColor: KanbanColorName) => onUpdateColumn?.(groupKey, { color: newColor }),
      onChangeColumnWipLimit: (wipLimit: number | undefined) => onUpdateColumn?.(groupKey, { wipLimit }),
      onDeleteColumn: () => onDeleteColumn?.(groupKey),
      // The finish travels through: the column's title field is what names the card, and a cell that
      // dropped it would leave every typed title behind for the placeholder they all start with.
      onAddItem: (finish?: KanbanAddFinish) => onAddItem(target, finish),
      onMoveColumn: (itemId: string, dir: CardMoveDirection) => onMoveCell(itemId, target, dir),
    }
  }, [cellGroupKey, laneKey, groupKey, setDragOverCell, handleColumnDrop, handleCardDrop, handleCardDragStart, handleColumnDragStart, onUpdateColumn, onDeleteColumn, onAddItem, onMoveCell])
}

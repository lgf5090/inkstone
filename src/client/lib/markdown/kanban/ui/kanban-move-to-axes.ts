import { useCallback, useRef } from 'react'
import { KANBAN_UNASSIGNED_KEY } from '../filter-sort'
import { kanbanBoardLayout } from '../swimlane'
import type { KanbanBoardCell } from '../swimlane'
import type { KanbanMovePivot } from '../dnd'
import type { KanbanData, KanbanOption, KanbanView } from '../types'

/**
 * The value a card holds on one axis, as the board reads it: the value itself, or the bucket key the
 * board uses for a card that names none. Anything else — a label where the board expects an id — is
 * handed back unchanged, so a menu move never rewrites a value it did not understand.
 */
function currentAxisKey(value: unknown): string {
  return value === undefined || value === null || value === '' ? KANBAN_UNASSIGNED_KEY : String(value)
}

export interface KanbanMoveToAxes {
  groupOptions?: KanbanOption[]
  laneOptions?: KanbanOption[]
  handleMoveItemToGroup: (itemId: string, groupKey: string) => void
  handleMoveItemToLane: (itemId: string, laneKey: string) => void
}

/**
 * The destinations the move-to menu offers and the writers that send a card to one. A move names one
 * coordinate and leaves the other alone, which is what a drop does: a column of a banded board never
 * writes the band, because the band a card is drawn in is the field that card already holds. A row
 * does name the column, and has to — the writer reorders within the column it is told, so a row move
 * that named none would drop the card out of its column and take its grouping with it.
 *
 * Both writers go through `moveItem`, the very path a drop takes, so a menu move clears the sorts a
 * manual order does not survive on and lands in the group's own order, exactly as a drag would.
 */
export function useKanbanMoveToAxes(
  data: KanbanData,
  activeView: KanbanView,
  moveItem: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void,
): KanbanMoveToAxes {
  const layout = kanbanBoardLayout(data, activeView)
  // The card is looked up at call time through the document the menu renders from, which keeps these
  // writers one identity for as long as the mover is.
  const dataRef = useRef(data)
  dataRef.current = data
  const { groupPropertyId, lanePropertyId } = layout

  const cardById = useCallback((itemId: string) => dataRef.current.items.find((item) => item.id === itemId), [])

  // A destination the card already names is the row the menu draws as checked. Writing it again would
  // spend a step of undo on a gesture that changed nothing, so both writers stop there.
  const handleMoveItemToGroup = useCallback((itemId: string, groupKey: string) => {
    const card = cardById(itemId)
    if (!card || currentAxisKey(card.properties[groupPropertyId]) === groupKey) return
    moveItem(itemId, { groupKey })
  }, [cardById, groupPropertyId, moveItem])

  const handleMoveItemToLane = useCallback((itemId: string, laneKey: string) => {
    const card = cardById(itemId)
    if (!card || !lanePropertyId || currentAxisKey(card.properties[lanePropertyId]) === laneKey) return
    moveItem(itemId, { groupKey: currentAxisKey(card.properties[groupPropertyId]), laneKey })
  }, [cardById, groupPropertyId, lanePropertyId, moveItem])

  return {
    groupOptions: layout.groupProperty?.options,
    laneOptions: layout.laneProperty?.options,
    handleMoveItemToGroup,
    handleMoveItemToLane,
  }
}

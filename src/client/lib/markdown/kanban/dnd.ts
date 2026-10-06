import type { KanbanItem, KanbanProperty } from './types'

export interface CardDragPayload {
  type: 'card'
  itemId: string
  sourceGroupKey: string
}

export interface ColumnDragPayload {
  type: 'column'
  groupKey: string
}

export type KanbanDragPayload = CardDragPayload | ColumnDragPayload

export function parseKanbanDragData(dataTransfer: DataTransfer): KanbanDragPayload | null {
  try {
    const raw = dataTransfer.getData('application/json')
    if (raw) {
      const parsed = JSON.parse(raw) as KanbanDragPayload
      if (parsed && (parsed.type === 'card' || parsed.type === 'column')) {
        return parsed
      }
    }
  } catch {
    // best-effort fallback if JSON parsing fails
  }
  const text = dataTransfer.getData('text/plain')
  if (text) {
    return { type: 'card', itemId: text, sourceGroupKey: '' }
  }
  return null
}

export interface KanbanMovePivot {
  itemId: string
  position: 'before' | 'after'
}

function appendAfterTargetGroup(
  result: KanbanItem[],
  updatedItem: KanbanItem,
  targetGroupItems: KanbanItem[],
): KanbanItem[] {
  const lastTargetItem = targetGroupItems[targetGroupItems.length - 1]!
  const insertAfterIdx = result.findIndex((it) => it.id === lastTargetItem.id)
  result.splice(insertAfterIdx + 1, 0, updatedItem)
  return result
}

function insertIntoTargetGroup(
  withoutItem: KanbanItem[],
  updatedItem: KanbanItem,
  targetGroupItems: KanbanItem[],
  pivot?: KanbanMovePivot,
): KanbanItem[] {
  const result = [...withoutItem]
  if (pivot) {
    const pivotIdx = result.findIndex((it) => it.id === pivot.itemId)
    if (pivotIdx !== -1) {
      result.splice(pivot.position === 'before' ? pivotIdx : pivotIdx + 1, 0, updatedItem)
      return result
    }
  }
  return appendAfterTargetGroup(result, updatedItem, targetGroupItems)
}

export function reorderKanbanItems(
  items: KanbanItem[],
  itemId: string,
  groupPropertyId: string,
  targetGroupKey: string,
  pivot?: KanbanMovePivot,
): KanbanItem[] {
  const itemIndex = items.findIndex((it) => it.id === itemId)
  if (itemIndex === -1) return items
  if (pivot && pivot.itemId === itemId) return items

  const currentItem = items[itemIndex]!
  const newGroupVal = targetGroupKey === '__none__' ? undefined : targetGroupKey
  const updatedItem: KanbanItem = {
    ...currentItem,
    properties: {
      ...currentItem.properties,
      [groupPropertyId]: newGroupVal,
    },
  }

  const withoutItem = items.filter((it) => it.id !== itemId)
  const targetGroupItems = withoutItem.filter((it) => {
    const v = it.properties[groupPropertyId]
    return targetGroupKey === '__none__' ? !v : v === targetGroupKey
  })

  if (targetGroupItems.length === 0) {
    return [...withoutItem, updatedItem]
  }

  return insertIntoTargetGroup(withoutItem, updatedItem, targetGroupItems, pivot)
}

/**
 * The order a table's rows would stand in if one row moved one step up or down — KU-21c's drag hands
 * over the same answer with a bigger step. The step is taken inside the row's own group (a drag
 * across groups is the board's move, which writes the group column; a reorder here is only ever a
 * change of place among the rows the reader is looking at), and the walk runs in document order, so
 * the result is what a reader dragging the row onto its neighbour expects. The list comes back
 * unchanged when the row is unknown, the neighbour is outside the same group, or the step is no
 * step at all — a no-op must not look like a change worth a step of undo.
 */
export function stepKanbanRowInGroup(
  items: KanbanItem[],
  itemId: string,
  groupPropertyId: string,
  offset: -1 | 1,
): KanbanItem[] {
  const index = items.findIndex((item) => item.id === itemId)
  if (index === -1) return items
  const groupValue = items[index]!.properties[groupPropertyId]
  let neighbour = index + offset
  // A neighbour that does not belong to the row's own group is not the row the reader aimed at: the
  // walk steps over it to the next row of the same group, and stops short at the group's edge.
  while (neighbour >= 0 && neighbour < items.length && items[neighbour]!.properties[groupPropertyId] !== groupValue) {
    neighbour += offset
  }
  if (neighbour < 0 || neighbour >= items.length) return items
  const next = [...items]
  const [moved] = next.splice(index, 1)
  next.splice(neighbour, 0, moved!)
  return next
}

/**
 * One row reorder a table view asks the board to write: the row that moves, the property its group is
 * read from, and either the row it was dropped on or the direction an arrow key pressed. Resolving
 * the step against the document the commit sees (not the slice a filtered view draws) is the writer's
 * business — see `stepKanbanRowToItem` / `stepKanbanRowInGroup`.
 */
export interface KanbanRowMove {
  itemId: string
  groupPropertyId: string
  /** The row the drag was dropped on; absent for a keyboard step. */
  targetId?: string
  /** The direction an arrow-key step takes, when no target row is named. */
  offset?: -1 | 1
}

/**
 * The order the rows stand in when `itemId` is dropped onto `targetId`: a whole-step move toward the
 * target, inside the mover's own group. A drop on a row of another group is not a reorder — crossing
 * groups is the board's move, which writes the group column — so it resolves to no change.
 */
export function stepKanbanRowToItem(
  items: KanbanItem[],
  itemId: string,
  targetId: string,
  groupPropertyId: string,
): KanbanItem[] {
  const from = items.findIndex((item) => item.id === itemId)
  const to = items.findIndex((item) => item.id === targetId)
  if (from === -1 || to === -1 || from === to) return items
  if (items[from]!.properties[groupPropertyId] !== items[to]!.properties[groupPropertyId]) return items
  return stepKanbanRowInGroup(items, itemId, groupPropertyId, to > from ? 1 : -1)
}

export function reorderKanbanColumns(
  columns: KanbanProperty[],
  groupByPropertyId: string,
  sourceGroupKey: string,
  targetGroupKey: string,
): KanbanProperty[] {
  return columns.map((col) => {
    if (col.id !== groupByPropertyId || !col.options) return col
    const sourceIdx = col.options.findIndex((o) => o.id === sourceGroupKey)
    const targetIdx = col.options.findIndex((o) => o.id === targetGroupKey)
    if (sourceIdx === -1 || targetIdx === -1 || sourceIdx === targetIdx) return col

    const nextOptions = [...col.options]
    const [moved] = nextOptions.splice(sourceIdx, 1)
    if (!moved) return col
    nextOptions.splice(targetIdx, 0, moved)
    return { ...col, options: nextOptions }
  })
}

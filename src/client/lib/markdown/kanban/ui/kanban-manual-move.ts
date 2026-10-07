import { useMemo, useRef } from 'react'
import { t } from '../../../i18n'
import { useUi } from '../../../../store/ui'
import type { KanbanMovePivot } from '../dnd'
import type { KanbanBoardCell } from '../swimlane'
import type { KanbanSort } from '../types'

export function makeMoveItemClearingSorts(deps: {
  moveItem: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void
  getSorts: () => KanbanSort[]
  clearSorts: () => void
  notifySortCleared: () => void
}): (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void {
  return (itemId, cell, pivot) => {
    deps.moveItem(itemId, cell, pivot)
    if (deps.getSorts().length > 0) {
      deps.clearSorts()
      deps.notifySortCleared()
    }
  }
}

export function useMoveItemClearingSorts(
  moveItem: (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void,
  filterSort: { sorts: KanbanSort[]; setSorts: (sorts: KanbanSort[]) => void },
) {
  const sortsRef = useRef(filterSort.sorts)
  sortsRef.current = filterSort.sorts
  // Identity tracks `moveItem` only: sorts are read at call time through the
  // ref, and `setSorts` is a stable state setter, so a stable moveItem yields
  // a stable handler for the whole drag.
  return useMemo(
    () => makeMoveItemClearingSorts({
      moveItem,
      getSorts: () => sortsRef.current,
      clearSorts: () => filterSort.setSorts([]),
      notifySortCleared: () => useUi.getState().toast({ title: t('preview.kanban_sort_cleared_for_drag') }),
    }),
    [moveItem],
  )
}

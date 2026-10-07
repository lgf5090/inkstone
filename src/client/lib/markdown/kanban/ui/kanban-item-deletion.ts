import { useCallback, useRef } from 'react'
import { t } from '../../../i18n'
import { toastWithUndo } from '../../../../store/ui'
import type { KanbanItem } from '../types'

/** Deleting cards is destructive, however many at a time, so its undo window outlives an informational toast. */
export const DESTRUCTIVE_UNDO_TOAST_MS = 8000

/**
 * Deleting one card by hand is as destructive as deleting a batch, so it gets the same way back:
 * a toast whose action runs the board's own undo. A card the board does not hold is not a deletion —
 * committing it would spend a step of undo and offer to restore what was never there — so the guard
 * reads the newest items through a ref rather than making this callback change identity every commit.
 */
export function useKanbanItemDeletion(
  items: KanbanItem[],
  deleteItem: (id: string) => void,
  undo: () => void,
): (id: string) => void {
  const itemsRef = useRef(items)
  itemsRef.current = items
  return useCallback((id: string) => {
    if (!itemsRef.current.some((item) => item.id === id)) return
    deleteItem(id)
    toastWithUndo(t('preview.kanban_card_deleted'), undo, { duration: DESTRUCTIVE_UNDO_TOAST_MS })
  }, [deleteItem, undo])
}

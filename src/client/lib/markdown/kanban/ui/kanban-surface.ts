import { useEffect, useRef, type RefObject } from 'react'
import { t } from '../../../i18n'
import { formatKanbanViewName } from '../i18n-helpers'
import { registerKanbanSurface, type KanbanSurfaceCommands } from '../surface-commands'
import type { useKanbanRootState } from './kanban-root-hooks'
import { kanbanViewIcon } from './kanban-view-tabs'

type KanbanRootState = ReturnType<typeof useKanbanRootState>

/**
 * What the palette may run against this board. "Select all" is scoped to the visible cards on
 * purpose — it is the same writer the context menu's own row calls, so a card the search has hidden
 * is never swept into a batch.
 */
function surfaceCommandsOf(state: KanbanRootState): KanbanSurfaceCommands {
  return {
    boardTitle: state.data.title?.trim() || t('preview.kanban'),
    views: state.data.views.map((view) => ({
      id: view.id,
      name: formatKanbanViewName(view),
      icon: kanbanViewIcon(view.type),
    })),
    activeViewId: state.filterSort.activeView.id,
    selectedCount: state.selection.selectedIds.size,
    canUndo: state.history.canUndo,
    canRedo: state.history.canRedo,
    addCard: () => state.adds.handleAddItem(),
    selectView: state.setActiveViewId,
    selectAllVisible: () => state.selection.handleToggleAll(state.filterSort.viewData.items.map((item) => item.id)),
    clearSelection: state.selection.handleClearSelection,
    undo: state.history.undo,
    redo: state.history.redo,
  }
}

/**
 * Publishes this board to the command palette for as long as it is on screen. The reader is held in a
 * ref rather than passed to the registry: the palette reads it when it opens, so re-registering on
 * every commit would only churn a map nobody is waiting on.
 */
export function useKanbanSurface(containerRef: RefObject<HTMLElement | null>, state: KanbanRootState): void {
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    return registerKanbanSurface(element, () => surfaceCommandsOf(stateRef.current))
  }, [containerRef])
}

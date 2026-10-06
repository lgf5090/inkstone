import { useCallback } from 'react'
import { toggleKanbanColumnSort, toggleKanbanHiddenColumn } from '../filter-sort'
import { toggleKanbanCardField } from '../card-fields'
import {
  addKanbanView,
  duplicateKanbanView,
  moveKanbanView,
  removeKanbanView,
  renameKanbanView,
} from '../view-ops'
import { t } from '../../../i18n'
import { toastWithUndo } from '../../../../store/ui'
import type { KanbanFilter, KanbanSort, KanbanView, KanbanViewType } from '../types'
import type { KanbanViewOperations } from './kanban-view-tabs'
import type { CardSize } from './kanban-view-options'
import type { CommitKanbanData } from './kanban-history'

// Unset lists reuse these constants so memoized consumers keep the same
// identity across renders that only touch other view fields.
const EMPTY_FILTERS: KanbanFilter[] = []
const EMPTY_SORTS: KanbanSort[] = []
const EMPTY_HIDDEN_COLUMNS: string[] = []
const EMPTY_CARD_FIELDS: string[] = []
const EMPTY_TAGS: string[] = []

// Both toggles read the committed view rather than the render-time one, so two
// clicks in one batch still cycle instead of both writing the same result.
//
// Every write in this file is a lookup — how an existing view shows the board — so every one of them
// commits as `view`, and none of them takes a step of the reader's way back. The rule, and what it
// costs, is stated in full at `KanbanCommitKind` in `kanban-history.ts`; `useKanbanViewOperations`
// below is the other half of it (which views exist is an edit, and the delete toast's undo depends on
// the delete being a step).
function useKanbanViewToggles(activeViewId: string, commitData: CommitKanbanData) {
  const toggleByCommittedView = useCallback(
    (toggle: (view: KanbanView) => Partial<KanbanView>) => {
      commitData((prev) => ({
        ...prev,
        views: prev.views.map((view) => (view.id === activeViewId ? { ...view, ...toggle(view) } : view)),
      }), 'view')
    },
    [activeViewId, commitData],
  )
  const toggleSortColumn = useCallback(
    (propertyId: string) => toggleByCommittedView((view) => ({ sorts: toggleKanbanColumnSort(view.sorts, propertyId) })),
    [toggleByCommittedView],
  )
  const toggleHiddenColumn = useCallback(
    (propertyId: string) =>
      toggleByCommittedView((view) => ({ hiddenColumns: toggleKanbanHiddenColumn(view.hiddenColumns, propertyId) })),
    [toggleByCommittedView],
  )
  const toggleCardField = useCallback(
    (propertyId: string) =>
      toggleByCommittedView((view) => ({ cardFields: toggleKanbanCardField(view.cardFields, propertyId) })),
    [toggleByCommittedView],
  )
  return { toggleSortColumn, toggleHiddenColumn, toggleCardField }
}

export function useKanbanViewState(
  activeView: KanbanView,
  activeViewId: string,
  commitData: CommitKanbanData,
) {
  const searchQuery = activeView.searchQuery ?? ''
  const filters = activeView.filters ?? EMPTY_FILTERS
  const sorts = activeView.sorts ?? EMPTY_SORTS
  const cardSize: CardSize = activeView.cardSize ?? 'medium'
  const hiddenColumns = activeView.hiddenColumns ?? EMPTY_HIDDEN_COLUMNS
  const cardFields = activeView.cardFields ?? EMPTY_CARD_FIELDS
  const selectedTags = activeView.selectedTags ?? EMPTY_TAGS
  const { toggleSortColumn, toggleHiddenColumn, toggleCardField } = useKanbanViewToggles(activeViewId, commitData)

  const updateActiveView = useCallback((patch: Partial<KanbanView>) => {
    commitData((prev) => ({
      ...prev,
      views: prev.views.map((v) => (v.id === activeViewId ? { ...v, ...patch } : v)),
    }), 'view')
  }, [activeViewId, commitData])

  const setSearchQuery = useCallback((q: string) => updateActiveView({ searchQuery: q }), [updateActiveView])
  const setSelectedTags = useCallback(
    (next: string[]) => updateActiveView({ selectedTags: next }),
    [updateActiveView],
  )
  const setFilters = useCallback((next: KanbanFilter[]) => updateActiveView({ filters: next }), [updateActiveView])
  const setSorts = useCallback((next: KanbanSort[]) => updateActiveView({ sorts: next }), [updateActiveView])
  const setCardSize = useCallback((next: CardSize) => updateActiveView({ cardSize: next }), [updateActiveView])

  return {
    searchQuery,
    setSearchQuery,
    selectedTags,
    setSelectedTags,
    filters,
    setFilters,
    sorts,
    setSorts,
    toggleSortColumn,
    cardSize,
    setCardSize,
    hiddenColumns,
    toggleHiddenColumn,
    cardFields,
    toggleCardField,
    updateActiveView,
  }
}

/** Destructive, so the way back stays on screen longer than an informational toast (as with cards). */
const VIEW_DELETE_UNDO_TOAST_MS = 8000

/**
 * The view switcher's document edits, on the board's one commit path — which is what makes a
 * deleted view recoverable by the same undo the toast hands over, and by nothing else.
 */
export function useKanbanViewOperations(
  views: KanbanView[],
  commitData: CommitKanbanData,
  undo: () => void,
): KanbanViewOperations {
  const createView = useCallback((type: KanbanViewType) => {
    commitData((prev) => addKanbanView(prev, type))
  }, [commitData])

  const renameView = useCallback((viewId: string, name: string) => {
    commitData((prev) => renameKanbanView(prev, viewId, name))
  }, [commitData])

  const duplicateView = useCallback((viewId: string) => {
    commitData((prev) => duplicateKanbanView(prev, viewId))
  }, [commitData])

  const moveView = useCallback((viewId: string, offset: -1 | 1) => {
    commitData((prev) => moveKanbanView(prev, viewId, offset))
  }, [commitData])

  const deleteView = useCallback((viewId: string) => {
    // The switcher already refuses, and a board cannot be left with no view to render — so neither
    // can the toast promising a way back over an edit that changed nothing.
    if (views.length < 1 + 1) return
    commitData((prev) => removeKanbanView(prev, viewId))
    toastWithUndo(t('preview.kanban_view_deleted'), undo, { duration: VIEW_DELETE_UNDO_TOAST_MS })
  }, [views.length, commitData, undo])

  return { createView, renameView, duplicateView, deleteView, moveView }
}

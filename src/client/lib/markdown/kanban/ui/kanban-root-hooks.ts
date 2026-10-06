import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import {
  applyKanbanFilters,
  applyKanbanSorts,
  searchKanbanItems,
} from '../filter-sort'
import { t } from '../../../i18n'
import { toastWithUndo } from '../../../../store/ui'
import type { KanbanMovePivot } from '../dnd'
import { kanbanPeopleDirectory } from '../person'
import { kanbanActiveItems, kanbanSetDeleted } from '../archive'
import { kanbanStatusColumn } from '../view-ops'
import { withKanbanDependenciesGuarded } from '../dependencies'
import { useKanbanBatchEdits } from './kanban-batch-edits'
import { useKanbanMoveToAxes } from './kanban-move-to-axes'
import { kanbanBoardLayout, moveKanbanItemToCell } from '../swimlane'
import type { KanbanBoardCell } from '../swimlane'
import { useKanbanArchive } from './kanban-archive'
import { createKanbanId } from '../id'
import type {
  KanbanAddFinish,
  KanbanColorName,
  KanbanData,
  KanbanFilter,
  KanbanItem,
  KanbanOption,
  KanbanProperty,
  KanbanSort,
  KanbanSubtask,
  KanbanView,
} from '../types'
import { useKanbanHistory, type CommitKanbanData } from './kanban-history'
import { useKanbanValueWrites } from './kanban-value-writes'
import { useKanbanViewOperations, useKanbanViewState } from './kanban-view-state'
import { useKanbanColumnOperations, useKanbanSchemaOperations } from './kanban-column-hooks'
import { useMoveItemClearingSorts } from './kanban-manual-move'
import { DESTRUCTIVE_UNDO_TOAST_MS, useKanbanItemDeletion } from './kanban-item-deletion'

function filterAndSortItems(
  items: KanbanItem[],
  searchQuery: string,
  selectedTags: string[],
  rules: { filters: KanbanFilter[]; sorts: KanbanSort[]; columns: KanbanProperty[] },
): KanbanItem[] {
  let result = searchKanbanItems(items, searchQuery)
  if (selectedTags.length > 0) {
    result = result.filter((item) => {
      const itemTags = Array.isArray(item.properties.tags) ? (item.properties.tags as string[]) : []
      const subtaskTags = item.subtasks?.flatMap((st) => st.tags || []) || []
      const combined = [...itemTags, ...subtaskTags]
      return selectedTags.some((tag) => combined.includes(tag))
    })
  }
  // The schema travels with the rules: a comparison is only meaningful as a question about the kind
  // of column the rule points at.
  const context = { columns: rules.columns }
  result = applyKanbanFilters(result, rules.filters, context)
  return applyKanbanSorts(result, rules.sorts, context)
}

export function useKanbanFilterSort(
  data: KanbanData,
  activeViewId: string,
  commitData: CommitKanbanData,
) {
  const activeView: KanbanView = useMemo(() => {
    return data.views.find((v) => v.id === activeViewId) || data.views[0] || {
      id: 'view-board',
      name: 'Board',
      type: 'board',
      groupBy: 'status',
    }
  }, [data.views, activeViewId])

  const viewState = useKanbanViewState(activeView, activeViewId, commitData)
  // The tag filter lives on the view with the search, the filters and the sorts beside it: they are one
  // idea, and leaving one of the four in component state meant a reader lost it on a view switch while
  // the other three came back.
  const { selectedTags, setSelectedTags } = viewState

  const onToggleTag = useCallback((tag: string) => {
    setSelectedTags(selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag])
  }, [selectedTags, setSelectedTags])

  const onClearTags = useCallback(() => {
    setSelectedTags([])
  }, [setSelectedTags])

  const filteredItems = useMemo(
    // An archived card is not part of the board any view can show, count or chart; the archive
    // panel is what brings it back.
    () => filterAndSortItems(kanbanActiveItems(data.items), viewState.searchQuery, selectedTags, {
      filters: viewState.filters,
      sorts: viewState.sorts,
      columns: data.columns,
    }),
    [data.items, data.columns, viewState.searchQuery, selectedTags, viewState.filters, viewState.sorts],
  )

  const viewData: KanbanData = useMemo(() => ({ ...data, items: filteredItems }), [data, filteredItems])

  return {
    activeView,
    ...viewState,
    selectedTags,
    setSelectedTags,
    onToggleTag,
    onClearTags,
    viewData,
  }
}

export function useKanbanItemMutations(
  commitData: CommitKanbanData,
  activeView: KanbanView,
  setDetailItem: (item: KanbanItem | null) => void,
) {
  const valueWrites = useKanbanValueWrites(commitData)

  // The view is read at drop time through this ref, so the mover keeps one identity for the whole
  // drag (the board memoizes on it) while still honouring the grouping the view has by then.
  const viewRef = useRef(activeView)
  viewRef.current = activeView

  const handleMoveItem = useCallback(
    (itemId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => {
      commitData((prev) => ({
        ...prev,
        items: moveKanbanItemToCell(prev.items, { itemId, cell, pivot, layout: kanbanBoardLayout(prev, viewRef.current) }),
      }))
    },
    [commitData],
  )

  const handleUpdateTitle = useCallback((id: string, newTitle: string) => {
    commitData((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === id ? { ...item, title: newTitle } : item)),
    }))
  }, [commitData])

  const handleUpdateItem = useCallback((updated: KanbanItem) => {
    commitData((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === updated.id ? updated : item)),
    }))
    setDetailItem(updated)
  }, [commitData, setDetailItem])

  return { handleMoveItem, handleUpdateTitle, handleUpdateItem, ...valueWrites }
}

/**
 * KU-23: the dependency list's one writer. The guarded pure layer does the filtering and the cycle
 * check against the document the commit sees; a refusal comes back as the same items, which the
 * commit pipeline already treats as a no-op, so a rejected edit takes no step of undo.
 */
export function useKanbanDependencyWrite(commitData: CommitKanbanData) {
  return useCallback(
    (itemId: string, deps: string[]) => {
      commitData((prev: KanbanData) => {
        const next = withKanbanDependenciesGuarded(prev.items, itemId, deps)
        return next === prev.items ? prev : { ...prev, items: next }
      })
    },
    [commitData],
  )
}

export function useKanbanItemLifecycle(
  data: KanbanData,
  commitData: CommitKanbanData,
  detailItem: KanbanItem | null,
  setDetailItem: (item: KanbanItem | null) => void,
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>,
) {
  const handleDeleteItem = useCallback((id: string) => {
    // Deleting is a flag, not a removal: the card leaves every view but stays in the document's
    // deleted list, where the archive panel can put it back — the purge is the irreversible half.
    commitData((prev) => {
      const items = kanbanSetDeleted(prev.items, [id], true)
      return items === prev.items ? prev : { ...prev, items }
    })
    if (detailItem?.id === id) setDetailItem(null)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [detailItem, commitData, setDetailItem, setSelectedIds])

  // Keeps `data`: the stripped parent shown in the detail panel must be the
  // same object inserted into the committed items array.
  const handleConvertSubtaskToItem = useCallback((itemId: string, subtaskId: string) => {
    const converted = convertSubtaskInItems(data.items, itemId, subtaskId)
    if (!converted) return
    commitData({ ...data, items: converted.items })
    if (detailItem?.id === itemId) setDetailItem(converted.strippedParent)
  }, [data, detailItem, commitData, setDetailItem])

  return { handleDeleteItem, handleConvertSubtaskToItem }
}

function convertSubtaskInItems(
  items: KanbanItem[],
  itemId: string,
  subtaskId: string,
): { items: KanbanItem[]; strippedParent: KanbanItem } | null {
  const parentIdx = items.findIndex((item) => item.id === itemId)
  const parent = parentIdx === -1 ? undefined : items[parentIdx]
  const subtask = parent?.subtasks?.find((st) => st.id === subtaskId)
  if (!parent || !subtask) return null
  const strippedParent: KanbanItem = {
    ...parent,
    subtasks: parent.subtasks?.filter((st) => st.id !== subtaskId),
  }
  const nextItems = [...items]
  nextItems[parentIdx] = strippedParent
  nextItems.splice(parentIdx + 1, 0, subtaskAsKanbanItem(subtask, parent.properties))
  return { items: nextItems, strippedParent }
}

function subtaskAsKanbanItem(
  subtask: KanbanSubtask,
  parentProperties: Record<string, unknown>,
): KanbanItem {
  const properties: Record<string, unknown> = {}
  const status = subtask.status ?? parentProperties.status
  if (status !== undefined) properties.status = status
  if (subtask.dueDate) properties.dueDate = subtask.dueDate
  if (subtask.startDate) properties.startDate = subtask.startDate
  if (subtask.priority) properties.priority = subtask.priority
  if (subtask.tags?.length) properties.tags = [...subtask.tags]
  const item: KanbanItem = {
    id: `item-${createKanbanId()}`,
    title: subtask.title,
    properties,
  }
  if (subtask.icon) item.icon = subtask.icon
  if (subtask.description) {
    item.content = subtask.description
    item.description = subtask.description
  }
  return item
}

export function useKanbanAddOperations(
  data: KanbanData,
  commitData: (next: KanbanData) => void,
  setDetailItem: (item: KanbanItem | null) => void,
  activeView: KanbanView,
) {
  const handleAddItem = useCallback((defaults?: Record<string, unknown>, finish?: KanbanAddFinish) => {
    const newItemId = `item-${createKanbanId()}`
    // The new card lands in the status column's first option — the column the resolvers pick, not a
    // conventional key. A board with no option column asks for nothing: writing an invented value
    // here used to file the card under an option that did not exist.
    const statusColumn = kanbanStatusColumn(data.columns)
    const statusVal = statusColumn?.options?.[0]?.id
    const propsObj: Record<string, unknown> = {
      ...(statusColumn && statusVal ? { [statusColumn.id]: statusVal } : {}),
      ...defaults,
    }
    // A card typed into a column is born named: the title field hands over what was typed, and the
    // placeholder stands in only for the doors that open the window for the reader to name it there.
    const typed = finish?.title?.trim() ?? ''
    const newItem: KanbanItem = {
      id: newItemId,
      title: typed === '' ? t('preview.kanban_new_task') : typed,
      properties: propsObj,
    }
    commitData({ ...data, items: [...data.items, newItem] })
    // The window is the wait the title field is avoiding, so it is opened by default rather than always.
    if (finish?.openDetail !== false) setDetailItem(newItem)
  }, [data, commitData, setDetailItem])

  // A board cell hands over both of its coordinates: the group belongs to the view's groupBy
  // property (not necessarily `status`), the band to its lane property. Either may be the
  // unassigned one, which asks for nothing rather than writing a sentinel into the new card.
  const handleAddItemInGroup = useCallback((cell?: KanbanBoardCell, finish?: KanbanAddFinish) => {
    const defaults: Record<string, unknown> = {}
    if (cell?.groupKey && cell.groupKey !== '__none__') defaults[activeView.groupBy || 'status'] = cell.groupKey
    const lanePropertyId = activeView.swimlaneBy
    if (lanePropertyId && cell?.laneKey && cell.laneKey !== '__none__') defaults[lanePropertyId] = cell.laneKey
    handleAddItem(defaults, finish)
  }, [activeView.groupBy, activeView.swimlaneBy, handleAddItem])

  // The add-group button targets the column the active view groups by;
  // option-less properties (text, date, ...) have no groups to add.
  const handleAddColumn = useCallback(() => {
    const groupCol = data.columns.find((c) => c.id === (activeView.groupBy || 'status'))
    if (!groupCol?.options) return
    const colors: KanbanColorName[] = ['blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'red', 'gray']
    const newColor = colors[groupCol.options.length % colors.length]!
    const newOpt: KanbanOption = {
      id: `${groupCol.id}-${createKanbanId()}`,
      label: t('preview.kanban_new_group_title', { value0: groupCol.options.length + 1 }),
      color: newColor,
    }
    const nextCols = data.columns.map((c) => (c.id === groupCol.id ? { ...c, options: [...c.options!, newOpt] } : c))
    commitData({ ...data, columns: nextCols })
  }, [data, commitData, activeView.groupBy])

  return { handleAddItem, handleAddItemInGroup, handleAddColumn }
}

export function computeSelectionAfterToggleAll(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev)
  const allSelected = ids.length > 0 && ids.every((id) => prev.has(id))
  for (const id of ids) {
    if (allSelected) next.delete(id)
    else next.add(id)
  }
  return next
}

export function useKanbanSelection(
  commitData: CommitKanbanData,
  groupColumn: KanbanProperty | undefined,
  activeView: KanbanView,
  undo: () => void,
) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])
  const batchEdits = useKanbanBatchEdits({ selectedIds, groupColumn, activeView, commitData, clearSelection })

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleAll = useCallback((ids: string[]) => {
    setSelectedIds((prev) => computeSelectionAfterToggleAll(prev, ids))
  }, [])

  const handleBatchDelete = useCallback(() => {
    const count = selectedIds.size
    if (count === 0) return
    // The batch twin of the soft delete above: flagged out of every view, recoverable from the panel.
    commitData((prev) => {
      const items = kanbanSetDeleted(prev.items, selectedIds, true)
      return items === prev.items ? prev : { ...prev, items }
    })
    clearSelection()
    toastWithUndo(t('preview.kanban_batch_deleted_count', { count }), undo, { duration: DESTRUCTIVE_UNDO_TOAST_MS })
  }, [selectedIds, commitData, clearSelection, undo])

  return {
    selectedIds,
    setSelectedIds,
    handleToggleSelect,
    handleToggleAll,
    handleClearSelection: clearSelection,
    handleBatchDelete,
    ...batchEdits,
  }
}

/** The two writers of the document itself rather than of a view's own fields: which view is open, and
 * the board's title. */
function useKanbanDocumentWriters(commitData: CommitKanbanData) {
  // Opening a different view is a lookup, not an edit: it is written into the document (so the board
  // comes back to it) but does not take a step of the reader's way back — Ctrl+Z after switching tabs
  // means "take back what I just did", not "put the tab back".
  const setActiveViewId = useCallback((viewId: string) => {
    commitData((prev) => ({ ...prev, activeViewId: viewId }), 'view')
  }, [commitData])

  const handleUpdateBoardTitle = useCallback(
    (title: string) => commitData((prev: KanbanData) => ({ ...prev, title })),
    [commitData],
  )

  return { setActiveViewId, handleUpdateBoardTitle }
}

export function useKanbanRootState(
  initialData: KanbanData,
  onUpdateData: (next: KanbanData) => void,
  containerRef: RefObject<HTMLElement | null>,
) {
  const history = useKanbanHistory(initialData, onUpdateData, containerRef)
  const { data, commitData } = history
  const activeViewId = data.activeViewId || data.views[0]?.id || 'view-board'
  const [detailItem, setDetailItem] = useState<KanbanItem | null>(null)

  const { setActiveViewId, handleUpdateBoardTitle } = useKanbanDocumentWriters(commitData)
  const filterSort = useKanbanFilterSort(data, activeViewId, commitData)
  const groupColumn = data.columns.find((c) => c.id === (filterSort.activeView.groupBy || 'status'))
  const selection = useKanbanSelection(commitData, groupColumn, filterSort.activeView, history.undo)
  const items = useKanbanItemMutations(commitData, filterSort.activeView, setDetailItem)
  const handleChangeDependencies = useKanbanDependencyWrite(commitData)
  const itemLifecycle = useKanbanItemLifecycle(data, commitData, detailItem, setDetailItem, selection.setSelectedIds)
  const adds = useKanbanAddOperations(data, commitData, setDetailItem, filterSort.activeView)
  const columnOps = useKanbanColumnOperations({ data, commitData, activeView: filterSort.activeView, undo: history.undo })
  const schemaOps = useKanbanSchemaOperations(commitData, history.undo)
  const viewOps = useKanbanViewOperations(data.views, commitData, history.undo)

  const handleMoveItem = useMoveItemClearingSorts(items.handleMoveItem, filterSort)
  const moveToAxes = useKanbanMoveToAxes(data, filterSort.activeView, handleMoveItem)
  const handleDeleteItem = useKanbanItemDeletion(data.items, itemLifecycle.handleDeleteItem, history.undo)
  // The roster a member picker offers: read off every card, so filtering the board down never
  // removes a teammate from the list of people who can be assigned.
  const people = useMemo(() => kanbanPeopleDirectory(data.columns, data.items), [data])
  const archive = useKanbanArchive(data, commitData, detailItem, setDetailItem, selection.setSelectedIds, handleDeleteItem)

  return {
    data,
    people,
    ...archive,
    detailItem,
    setDetailItem,
    setActiveViewId,
    commitData,
    filterSort,
    groupColumn,
    moveToAxes,
    selection,
    items: { ...items, ...itemLifecycle, handleMoveItem, handleDeleteItem, handleChangeDependencies },
    adds,
    columnOps,
    schemaOps,
    viewOps,
    history,
    handleUpdateBoardTitle,
  }
}

function duplicateKanbanItem(item: KanbanItem): KanbanItem {
  return {
    ...item,
    id: `item-${createKanbanId()}`,
    title: `${item.title} (${t('common.copy')})`,
    subtasks: item.subtasks?.map((st) => ({
      ...st,
      id: `subtask-${createKanbanId()}`,
    })),
  }
}

export function useKanbanContextMenuState(
  data: KanbanData,
  commitData: CommitKanbanData,
) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [targetItem, setTargetItem] = useState<KanbanItem | null>(null)

  const handleDuplicateItem = useCallback(
    (item: KanbanItem) => {
      const newItem = duplicateKanbanItem(item)
      commitData((prev) => {
        const nextItems = [...prev.items]
        const idx = nextItems.findIndex((i) => i.id === item.id)
        if (idx >= 0) nextItems.splice(idx + 1, 0, newItem)
        else nextItems.push(newItem)
        return { ...prev, items: nextItems }
      })
    },
    [commitData],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) {
        e.stopPropagation()
        return
      }
      e.preventDefault()
      e.stopPropagation()

      const itemEl = target.closest('[data-item-id]') as HTMLElement | null
      const itemId = itemEl?.dataset.itemId
      const found = itemId ? data.items.find((it) => it.id === itemId) || null : null

      setTargetItem(found)
      setPoint({ x: e.clientX, y: e.clientY })
    },
    [data.items],
  )

  const handleClose = useCallback(() => {
    setPoint(null)
    setTargetItem(null)
  }, [])

  return { point, targetItem, handleContextMenu, handleClose, handleDuplicateItem }
}


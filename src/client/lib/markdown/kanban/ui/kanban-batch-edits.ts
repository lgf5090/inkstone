import { useCallback } from 'react'
import { kanbanBoardLayout, moveKanbanItemsToCell } from '../swimlane'
import type { KanbanBoardCell } from '../swimlane'
import type { KanbanMovePivot } from '../dnd'
import { appendOptionToColumn } from './kanban-column-hooks'
import type { CommitKanbanData } from './kanban-history'
import type { KanbanOption, KanbanProperty, KanbanView } from '../types'

/**
 * What a card carries under a multi-select property: the list it holds, or the single value a board
 * authored elsewhere wrote where a list belongs. Reading it here rather than at each call site keeps
 * the batch editor from mistaking a string for a list and losing the tag it was meant to add to.
 */
export function kanbanTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return typeof value === 'string' && value ? [value] : []
}

export interface KanbanBatchEditsApi {
  handleBatchGroupChange: (groupId: string) => void
  /** The drag a batch makes: every picked card into the dropped cell, the held one under the pointer. */
  handleBatchMove: (anchorId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => void
  handleBatchSetProperty: (propertyId: string, value: unknown) => void
  handleBatchAddTag: (propertyId: string, tagId: string, newOption?: KanbanOption) => void
}

interface KanbanBatchEditScope {
  selectedIds: Set<string>
  /** The field the batch bar's group picker writes; the view's grouping property, not always `status`. */
  groupColumn?: KanbanProperty
  /** The view a drag drops into: its groupings decide which cell means which field. */
  activeView: KanbanView
  commitData: CommitKanbanData
  clearSelection: () => void
}

/**
 * Moving the whole batch into another group. The one batch write that ends the selection, because it
 * relocates the cards the batch was gathered around — what is left in the columns the reader picked
 * from is no longer the set they are working on.
 */
function useKanbanBatchGroupChange({
  selectedIds,
  groupColumn,
  commitData,
  clearSelection,
}: KanbanBatchEditScope) {
  return useCallback(
    (groupId: string) => {
      if (selectedIds.size === 0) return
      const propertyId = groupColumn?.id || 'status'
      // A multi-select column keeps its array shape. The value the picker sent replaces the field
      // wholesale: a group is what the board cuts columns by, so a card cannot stand in two at once.
      const value = groupColumn?.type === 'multi-select' ? [groupId] : groupId
      commitData((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          selectedIds.has(item.id) ? { ...item, properties: { ...item.properties, [propertyId]: value } } : item,
        ),
      }))
      clearSelection()
    },
    [selectedIds, groupColumn?.id, groupColumn?.type, commitData, clearSelection],
  )
}

/**
 * A drag that carried a batch: the cards the reader picked all land in the cell they dropped the held
 * card into, which is the same move the single-card drop makes with more cards behind it. The layout is
 * read from the document the commit is about to write, so the band it lands in is the band the board
 * drew from the same groupings.
 */
function useKanbanBatchMove({ selectedIds, activeView, commitData, clearSelection }: KanbanBatchEditScope) {
  return useCallback(
    (anchorId: string, cell: KanbanBoardCell, pivot?: KanbanMovePivot) => {
      if (selectedIds.size === 0) return
      const itemIds = [...selectedIds]
      commitData((prev) => ({
        ...prev,
        items: moveKanbanItemsToCell(prev.items, {
          itemIds: itemIds.includes(anchorId) ? itemIds : [anchorId, ...itemIds],
          anchorId,
          cell,
          pivot,
          layout: kanbanBoardLayout(prev, activeView),
        }),
      }))
      // As with the group picker: what is left in the columns the batch was gathered in is no longer
      // the set the reader was working on.
      clearSelection()
    },
    [selectedIds, activeView, commitData, clearSelection],
  )
}

/**
 * Batch writes of one field, in one commit for the whole selection. They leave every card exactly
 * where it stands, so the selection survives them: a reader who has just re-aimed twenty cards may
 * well want to tag them next, and picking them again is the very cost this bar exists to remove.
 */
function useKanbanBatchFieldWrites(selectedIds: Set<string>, commitData: CommitKanbanData) {
  const handleBatchSetProperty = useCallback(
    (propertyId: string, value: unknown) => {
      if (selectedIds.size === 0) return
      commitData((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          selectedIds.has(item.id) ? { ...item, properties: { ...item.properties, [propertyId]: value } } : item,
        ),
      }))
    },
    [selectedIds, commitData],
  )

  const handleBatchAddTag = useCallback(
    (propertyId: string, tagId: string, newOption?: KanbanOption) => {
      if (selectedIds.size === 0) return
      commitData((prev) => ({
        ...prev,
        items: prev.items.map((item) => {
          if (!selectedIds.has(item.id)) return item
          const tags = kanbanTagList(item.properties[propertyId])
          // A card that already carries the tag is handed back untouched, so the editor never adds a
          // second copy of a value the reader can only see once.
          if (tags.includes(tagId)) return item
          return { ...item, properties: { ...item.properties, [propertyId]: [...tags, tagId] } }
        }),
        columns: newOption ? appendOptionToColumn(prev.columns, propertyId, newOption) : prev.columns,
      }))
    },
    [selectedIds, commitData],
  )

  return { handleBatchSetProperty, handleBatchAddTag }
}

export function useKanbanBatchEdits(scope: KanbanBatchEditScope): KanbanBatchEditsApi {
  const handleBatchGroupChange = useKanbanBatchGroupChange(scope)
  const handleBatchMove = useKanbanBatchMove(scope)
  const { handleBatchSetProperty, handleBatchAddTag } = useKanbanBatchFieldWrites(scope.selectedIds, scope.commitData)
  return { handleBatchGroupChange, handleBatchMove, handleBatchSetProperty, handleBatchAddTag }
}

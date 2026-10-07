import { useCallback } from 'react'
import { stepKanbanRowInGroup, stepKanbanRowToItem, type KanbanRowMove } from '../dnd'
import { appendOptionToColumn } from './kanban-column-hooks'
import type { CommitKanbanData } from './kanban-history'
import type { KanbanData, KanbanFile, KanbanItem, KanbanOption, KanbanSubtask } from '../types'

/**
 * A card's days, moved by a drag on the timeline or the gantt. One commit for both of the days a bar
 * spans, because they are one gesture: two writes would put two steps in the undo stack and the reader
 * would have to press undo twice to take back a single drag.
 */
function useKanbanRescheduleWrite(commitData: CommitKanbanData) {
  return useCallback(
    (id: string, patch: Record<string, string>) => {
      if (Object.keys(patch).length === 0) return
      commitData((prev: KanbanData) => withItemProperties(prev, id, patch))
    },
    [commitData],
  )
}

/** Several of one item's own properties in one commit — the shape a drag that moves two dates needs. */
function withItemProperties(prev: KanbanData, id: string, patch: Record<string, unknown>): KanbanData {
  return {
    ...prev,
    items: prev.items.map((item) =>
      item.id === id ? { ...item, properties: { ...item.properties, ...patch } } : item,
    ),
  }
}

/** One item's own property, merged into the newest document; a brand new option rides the same commit. */
function withItemProperty(
  prev: KanbanData,
  id: string,
  columnId: string,
  value: unknown,
  newOption?: KanbanOption,
): KanbanData {
  const next = withItemProperties(prev, id, { [columnId]: value })
  return newOption ? { ...next, columns: appendOptionToColumn(prev.columns, columnId, newOption) } : next
}

/**
 * KU-21c: the table's row order, as the document's item order. The gesture names the move; this
 * writer resolves it against the newest *whole* document — not the slice a filtered view draws —
 * so a step reads the order the reader sees and a no-op (a cross-group drop, a step off a group's
 * edge) commits nothing rather than taking a step of undo.
 */
function useKanbanRowReorderWrite(commitData: CommitKanbanData) {
  return useCallback(
    (move: KanbanRowMove) => {
      commitData((prev: KanbanData) => {
        const next = move.targetId !== undefined
          ? stepKanbanRowToItem(prev.items, move.itemId, move.targetId, move.groupPropertyId)
          : stepKanbanRowInGroup(prev.items, move.itemId, move.groupPropertyId, move.offset ?? 1)
        return next === prev.items ? prev : { ...prev, items: next }
      })
    },
    [commitData],
  )
}

/** One card's cell writes: the file list, the subtask list, one property cell, one multi-select cell. */
function useKanbanCellWrites(commitData: CommitKanbanData) {
  const patchItem = useCallback((id: string, patch: Partial<KanbanItem>) => {
    commitData((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }))
  }, [commitData])

  const handleUpdateFiles = useCallback(
    (id: string, files: KanbanFile[]) => patchItem(id, { files }),
    [patchItem],
  )

  const handleUpdateSubtasks = useCallback(
    (id: string, subtasks: KanbanSubtask[]) => patchItem(id, { subtasks }),
    [patchItem],
  )

  const handleUpdateProperty = useCallback(
    (id: string, propertyId: string, value: unknown) => {
      commitData((prev: KanbanData) => withItemProperty(prev, id, propertyId, value))
    },
    [commitData],
  )

  const handleUpdateMultiSelect = useCallback(
    (id: string, columnId: string, values: string[], newOption?: KanbanOption) => {
      commitData((prev: KanbanData) => withItemProperty(prev, id, columnId, values, newOption))
    },
    [commitData],
  )

  return { handleUpdateFiles, handleUpdateSubtasks, handleUpdateProperty, handleUpdateMultiSelect }
}

/**
 * One item's own fields, as a view writes them: its attachments, its subtasks, one cell of it. Every
 * writer here is built from the document the commit sees rather than from the render that asked for
 * it, so an unchanged writer keeps one identity for the board's whole life — which is what lets the
 * views below stay memoized. A closure minted per render made every card's props new, so a click
 * that only opened one card's detail panel repainted the entire board (K-19).
 */
export function useKanbanValueWrites(commitData: CommitKanbanData) {
  const { handleUpdateFiles, handleUpdateSubtasks, handleUpdateProperty, handleUpdateMultiSelect } =
    useKanbanCellWrites(commitData)

  const handleRescheduleItem = useKanbanRescheduleWrite(commitData)

  const handleReorderRows = useKanbanRowReorderWrite(commitData)

  const handleUpdateTags = useCallback(
    (id: string, tags: string[], newOption?: KanbanOption) => {
      handleUpdateMultiSelect(id, 'tags', tags, newOption)
    },
    [handleUpdateMultiSelect],
  )

  return {
    handleUpdateFiles,
    handleUpdateSubtasks,
    handleUpdateProperty,
    handleRescheduleItem,
    handleReorderRows,
    handleUpdateMultiSelect,
    handleUpdateTags,
  }
}

import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { KanbanRowMove } from '../dnd'
import type { KanbanItem } from '../types'

/**
 * The table view's own drag, as one behaviour for every group of rows it draws: a row dragged onto
 * another row of the same group takes that row's place, and `Shift`+arrow walks the focused row one
 * step without the pointer (KU-21c). The table had no drag at all — the one surface in the module a
 * reader could not rearrange — and it draws rows in document order, so a reorder is a write of the
 * document's `items` array rather than a property change: one commit, one step of undo.
 *
 * The gesture is the board's own (`draggable` + `drop`), reading the same payload convention: the id
 * travels in `dataTransfer` and the in-flight ref is what this table trusts on the drop. The row is
 * dropped onto a *row*, never onto a group, and the writer resolves the move against the whole
 * document — a drop on a row of another group, or a step off a group's edge, resolves to no change
 * there, so a no-op never reaches the note.
 */

/** The payload one table row writes when a drag begins, and the drop reads back. */
const ROW_MOVE_MIME = 'application/x-inkstone-kanban-row'

export interface TableReorderProps {
  /** The row's draggable props, keyed on the card they carry. */
  rowProps: (item: KanbanItem) => {
    draggable: boolean
    onDragStart: (e: DragEvent<HTMLElement>) => void
    onDragEnd: () => void
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
  }
  /** The keyboard walk: one step of the group the focused row stands in, per press. */
  rowKeyDown: (item: KanbanItem, e: KeyboardEvent<HTMLElement>) => void
  /** Whether a drag is in flight, which is what turns the drag cursor on. */
  isDragging: boolean
}

interface TableReorderOptions {
  /** The property the table is grouped by, which bounds both the drop and the keyboard walk. */
  groupPropertyId: string
  /** The row moves this gesture reports; the writer resolves them against the document. */
  onMove: (move: KanbanRowMove) => void
}

/** The keyboard walk, defined once: `Shift`+arrow takes one step of the row's own group per press. */
function rowStepKeyDown(groupPropertyId: string, onMove: (move: KanbanRowMove) => void) {
  return (item: KanbanItem, e: KeyboardEvent<HTMLElement>) => {
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    onMove({ itemId: item.id, groupPropertyId, offset: e.key === 'ArrowDown' ? 1 : -1 })
  }
}

export function useKanbanTableReorder({ groupPropertyId, onMove }: TableReorderOptions): TableReorderProps {
  // The row in flight. A ref rather than state: the drag frames must not re-render the table.
  const itemRef = useRef<KanbanItem | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const rowProps = (item: KanbanItem) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      itemRef.current = item
      setIsDragging(true)
      try {
        e.dataTransfer.setData(ROW_MOVE_MIME, item.id)
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
      }
      catch {
        // Best-effort: an engine that refuses custom payloads still gets the in-flight ref, and
        // the drop on this table reads that one; the payload copy is for drags that leave the board.
      }
    },
    onDragEnd: () => {
      itemRef.current = null
      setIsDragging(false)
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const held = itemRef.current
      if (!held || held.id === item.id) return
      // Only a row of the held row's own group accepts it: a cross-group drop is the board's move,
      // which this gesture does not write, so the browser is told the row is not a target here.
      if (held.properties[groupPropertyId] !== item.properties[groupPropertyId]) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const held = itemRef.current
      if (!held || held.id === item.id) return
      e.preventDefault()
      itemRef.current = null
      setIsDragging(false)
      onMove({ itemId: held.id, groupPropertyId, targetId: item.id })
    },
  })

  const rowKeyDown = rowStepKeyDown(groupPropertyId, onMove)

  return { rowProps, rowKeyDown, isDragging }
}

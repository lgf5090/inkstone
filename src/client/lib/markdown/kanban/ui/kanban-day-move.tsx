import { useCallback, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
// `MouseEvent` above is React's synthetic click; nothing from the DOM namespace is needed.
import { t } from '../../../i18n'
import { addDaysKey, formatDateKey } from '../../../time'
import { calendarMoveDays, moveCalendarItemToDay } from '../calendar-helpers'
import type { KanbanItem } from '../types'

/**
 * Moving a card to another day on the calendar, as one behaviour for every bar the month grid draws.
 * A calendar bar already answered one press — it opened the card — and the plan this module keeps
 * (KU-21b) asks for the second: the bar dragged onto another day, with the same keyboard equivalent
 * the time views give their bars, because a card that can only be moved by a mouse is the shape of
 * defect this repo has already had to fix twice (SH-110, K-20).
 *
 * The gesture is the HTML5 one the board itself uses (`draggable` + `drop`), not the pointer-capture
 * drag the time views use: a calendar bar sits in a grid of cells that are already the drop targets,
 * so the browser's own drag-and-drop reaches them all without this layer tracking a pointer. Nothing
 * is written until the drop lands; a drag that ends anywhere that is not a day writes nothing. The
 * write goes through the pure layer — one patch, one commit — and a press that did not drag is left
 * to the click that opens the card.
 */

/** The payload one calendar bar writes when a drag begins, and the drop reads back. */
const DAY_MOVE_MIME = 'application/x-inkstone-kanban-day'

interface DayMoveOptions {
  /** The column the view draws its bars from, which is also where the moved day is written. */
  dateField?: string
  onMove: (itemId: string, patch: Record<string, string>) => void
}

/**
 * What outlives one bar of the gesture: the bar in flight, and the click an engine may still send
 * after its drop. Both are refs rather than state — the drag frames must not re-render the month.
 */
interface DragState {
  itemRef: { current: KanbanItem | null }
  suppressClickRef: { current: boolean }
}

export interface DayMoveApi {
  /** The bar's draggable props, keyed on the card they carry. */
  barProps: (item: KanbanItem) => {
    draggable: boolean
    onDragStart: (e: DragEvent<HTMLElement>) => void
    onDragEnd: () => void
    /** A press that dragged does not open the card; a plain press still does. */
    onClickCapture: (e: MouseEvent<HTMLElement>) => void
  }
  /** The day cell's drop-target props, keyed on the day it names. */
  dayProps: (day: string) => {
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
  }
  /** The keyboard walk: one step of the calendar the bar sits on, per press. */
  barKeyDown: (item: KanbanItem, e: KeyboardEvent<HTMLElement>) => void
  /**
   * The region that says out loud where the card went. Rendered whether or not it has anything to
   * say: a live region inserted at the moment it speaks is usually dropped by screen readers, which
   * is why this one is part of the view rather than something the drag conjures up.
   */
  status: ReactNode
}

/** The bar's own half of the gesture, written as a function of the state so the hook stays small. */
function barPropsFor(state: DragState, item: KanbanItem): DayMoveApi['barProps'] extends (item: KanbanItem) => infer P ? P : never {
  return {
    draggable: true,
    onDragStart: (e) => {
      state.itemRef.current = item
      try {
        e.dataTransfer.setData(DAY_MOVE_MIME, item.id)
        e.dataTransfer.setData('text/plain', item.id)
        e.dataTransfer.effectAllowed = 'move'
      }
      catch {
        // Best-effort: an engine that refuses custom payloads still gets the in-flight ref, and
        // the drop on this board reads that one; the payload copy is for drags that leave the board.
      }
    },
    onDragEnd: () => {
      state.itemRef.current = null
      // Browsers do not send a `click` after a completed drag-and-drop; this guard is for the ones
      // that do, and costs one flag on the ones that don't.
      state.suppressClickRef.current = true
    },
    onClickCapture: (e) => {
      // The press that dragged is not the press that opens the card, even where an engine still
      // sends its click: the pointer came up somewhere else.
      if (!state.suppressClickRef.current) return
      state.suppressClickRef.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}

/** The day cell's half: a drop target that names its day and writes the bar it receives onto it. */
function dayPropsFor(state: DragState, commit: (item: KanbanItem, day: string) => void, day: string): DayMoveApi['dayProps'] extends (day: string) => infer P ? P : never {
  return {
    onDragOver: (e) => {
      if (!state.itemRef.current) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e) => {
      const item = state.itemRef.current
      if (!item) return
      e.preventDefault()
      state.itemRef.current = null
      commit(item, day)
    },
  }
}

export function useKanbanDayMove({ dateField, onMove }: DayMoveOptions): DayMoveApi {
  const [announcement, setAnnouncement] = useState('')
  const itemRef = useRef<KanbanItem | null>(null)
  const suppressClickRef = useRef(false)
  const state: DragState = { itemRef, suppressClickRef }

  const commit = useCallback(
    (item: KanbanItem, day: string) => {
      const patch = moveCalendarItemToDay(item, day, dateField)
      if (Object.keys(patch).length === 0) return
      onMove(item.id, patch)
      setAnnouncement(
        t('preview.kanban_moved_to_date', { title: item.title || t('preview.kanban_untitled'), date: formatDateKey(day) }),
      )
    },
    [dateField, onMove],
  )

  return {
    barProps: (item) => barPropsFor(state, item),
    dayProps: (day) => dayPropsFor(state, commit, day),
    barKeyDown: (item, e) => {
      if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      e.preventDefault()
      // The bar's own day is what an arrow steps from; a card with no day at all writes nothing.
      const startKey = calendarMoveDays(item, dateField).start?.day
      if (!startKey) return
      commit(item, addDaysKey(startKey, e.key === 'ArrowRight' ? 1 : -1))
    },
    status: (
      <span data-kanban-day-status role='status' aria-live='polite' className='sr-only'>
        {announcement}
      </span>
    ),
  }
}

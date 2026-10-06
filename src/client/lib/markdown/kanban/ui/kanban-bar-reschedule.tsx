import { useCallback, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent, type ReactNode } from 'react'
import { t } from '../../../i18n'
import { formatDateKey } from '../../../time'
import {
  shiftTimelineProperties,
  timelineAnnouncedDay,
  timelineDragDays,
  type TimelineDayFields,
} from '../timeline-helpers'
import type { KanbanItem } from '../types'

/**
 * Moving a card's days by dragging its bar, as one behaviour for the two time views. They draw the same
 * grid and the same kind of bar, so a reader who has learned the gesture on one has learned it on both —
 * and a gesture is not the place for two implementations to drift apart.
 *
 * Nothing is written until the pointer is let go. The bar is moved by writing a transform straight onto
 * the element, which is the same choice the column resize handle makes and for the same reason: a drag
 * is scores of frames, and routing each of them through a React render would repaint the whole grid —
 * every other bar included — to move one. On release the drag becomes a whole number of days, the patch
 * is computed by the pure layer, and the view's writer takes it in one commit.
 *
 * The keyboard gets the same move without the pointer: `Shift`+arrow on the focused bar shifts its days
 * by one, which is the only way a reader who does not drag can change a date from this view at all (the
 * detail dialog can too, but that is a different surface, and a bar that can only be moved by a mouse is
 * the shape of defect this repo has already had to fix twice — SH-110, K-20).
 */

/** How far a press must travel before it is a drag rather than a click that shook a little. */
const DRAG_THRESHOLD_PX = 4

export interface BarRescheduleApi {
  /** The props one bar carries: the drag, the keyboard nudge, and the press that only opens the card. */
  barProps: (item: KanbanItem, onActivate: () => void) => BarRescheduleProps
  /**
   * The region that says out loud where the card went. It is rendered whether or not it has anything to
   * say: a live region inserted at the moment it speaks is usually dropped by screen readers, which is
   * why this one is part of the view rather than something the drag conjures up.
   */
  status: ReactNode
}

export interface BarRescheduleProps {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
  onClick: () => void
}

interface BarDragOptions {
  /** What one day costs in pixels at the scale the grid is drawn at. */
  dayWidth: number
  /** The columns the view draws its days from, so the write lands on the same ones. */
  fields?: TimelineDayFields
  onShift: (itemId: string, patch: Record<string, string>) => void
}

interface ActiveDrag {
  id: string
  element: HTMLElement
  startX: number
  /** True once the press has travelled far enough to be a drag, which is what suppresses the click. */
  moved: boolean
  days: number
  pointerId: number
}

/** What the gesture needs that outlives one bar: the live drag, and the click it has to swallow. */
interface DragState {
  dayWidth: number
  dragRef: MutableRefObject<ActiveDrag | null>
  suppressClickRef: MutableRefObject<boolean>
}

function endDrag(state: DragState, e: PointerEvent<HTMLElement>): void {
  const drag = state.dragRef.current
  if (!drag || drag.pointerId !== e.pointerId) return
  state.dragRef.current = null
  // The preview is dropped either way: what the bar shows is the document's day again, and when the
  // drag is committed the document is the moved one.
  drag.element.style.transform = ''
  drag.element.releasePointerCapture?.(drag.pointerId)
  state.suppressClickRef.current = drag.moved
}

function startDrag(state: DragState, item: KanbanItem, e: PointerEvent<HTMLElement>): void {
  // A second button is a context menu, not a drag; and a press that started on the bar's own label is
  // still the bar's press, so nothing here filters by target.
  if (e.button !== 0) return
  state.dragRef.current = { id: item.id, element: e.currentTarget, startX: e.clientX, moved: false, days: 0, pointerId: e.pointerId }
  state.suppressClickRef.current = false
  // Captured so the drag survives the pointer leaving the bar — which it always does, since the bar is
  // 24px tall and a reader moving it to another week crosses the rest of the grid.
  e.currentTarget.setPointerCapture?.(e.pointerId)
}

function moveDrag(state: DragState, item: KanbanItem, e: PointerEvent<HTMLElement>): void {
  const drag = state.dragRef.current
  if (!drag || drag.pointerId !== e.pointerId || drag.id !== item.id) return
  const dx = e.clientX - drag.startX
  if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
  drag.moved = true
  drag.days = timelineDragDays(dx, state.dayWidth)
  drag.element.style.transform = `translateX(${dx}px)`
}

/**
 * The props one bar carries. Written as a function of the gesture's state rather than inside the hook so
 * the hook below is only what React has to hold — a drag in flight and the click it swallowed — while the
 * six handlers that read it stay one screen tall and testable by reading them.
 */
function barPropsFor(
  state: DragState,
  commit: (item: KanbanItem, days: number) => void,
  item: KanbanItem,
  onActivate: () => void,
): BarRescheduleProps {
  return {
    onPointerDown: (e) => startDrag(state, item, e),
    onPointerMove: (e) => moveDrag(state, item, e),
    onPointerUp: (e) => {
      const drag = state.dragRef.current
      if (!drag || drag.pointerId !== e.pointerId || drag.id !== item.id) return
      const { days, moved } = drag
      endDrag(state, e)
      if (moved) commit(item, days)
    },
    onPointerCancel: (e) => endDrag(state, e),
    onKeyDown: (e) => {
      if (!e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      e.preventDefault()
      commit(item, e.key === 'ArrowRight' ? 1 : -1)
    },
    onClick: () => {
      // The press that dragged is not the press that opens the card: the pointer came up somewhere else,
      // so the click the browser still sends is the drag's tail rather than the reader's intent.
      if (state.suppressClickRef.current) {
        state.suppressClickRef.current = false
        return
      }
      onActivate()
    },
  }
}

export function useBarReschedule({ dayWidth, fields, onShift }: BarDragOptions): BarRescheduleApi {
  const [announcement, setAnnouncement] = useState('')
  const dragRef = useRef<ActiveDrag | null>(null)
  const suppressClickRef = useRef(false)
  const state: DragState = { dayWidth, dragRef, suppressClickRef }

  const commit = useCallback(
    (item: KanbanItem, days: number) => {
      const patch = shiftTimelineProperties(item, fields, days)
      if (Object.keys(patch).length === 0) return
      onShift(item.id, patch)
      const day = timelineAnnouncedDay(item, fields, patch)
      setAnnouncement(
        t('preview.kanban_moved_to_date', { title: item.title || t('preview.kanban_untitled'), date: formatDateKey(day) }),
      )
    },
    [fields, onShift],
  )

  return {
    barProps: (item, onActivate) => barPropsFor(state, commit, item, onActivate),
    status: (
      <span data-kanban-bar-status role='status' aria-live='polite' className='sr-only'>
        {announcement}
      </span>
    ),
  }
}

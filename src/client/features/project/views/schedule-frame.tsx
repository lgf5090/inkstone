/**
 * The axis both schedule views draw on: a two-tier head, a frozen column of row names, and a canvas
 * that scrolls under them.
 *
 * The head and the name column are translated rather than sticky, because a sticky element inside a
 * horizontally scrolling flex row jitters against the canvas on every frame. Only the rows inside the
 * viewport are mounted, so a board with two thousand cards scrolls like one with twenty.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { TimelineDay } from '@shared/project/timeline-layout'
import { useLocale } from '../../../lib/i18n'

const BUFFER_ROWS = 6
const HEAD_BUFFER_PX = 400

export interface ScheduleFrameProps {
  days: readonly TimelineDay[]
  columnPx: number
  rowCount: number
  rowHeight: number
  corner: ReactNode
  showToday: boolean
  showWeekends: boolean
  panEnabled?: boolean
  drawEnabled?: boolean
  renderLeftRow: (index: number) => ReactNode
  renderRow: (index: number) => ReactNode
  overlay?: (visible: { first: number, last: number }) => ReactNode
  canvasExtra?: ReactNode
  onCanvasPointerDown?: (event: React.PointerEvent, context: { column: number, row: number }) => void
  onViewport?: (node: HTMLDivElement | null) => void
  /** The column the axis opens on; re-centred whenever the axis itself changes, not on every render. */
  focusColumn?: number
  emptyHint?: string
}

export function ScheduleFrame(props: ScheduleFrameProps): ReactElement {
  const { days, columnPx, rowCount, rowHeight, showToday, showWeekends } = props
  const locale = useLocale()
  const scroller = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ top: 0, left: 0 })
  const [size, setSize] = useState({ width: 900, height: 600 })
  const totalWidth = days.length * columnPx
  const totalHeight = rowCount * rowHeight

  const measure = useCallback(() => {
    const node = scroller.current
    if (!node) return
    setOffset({ top: node.scrollTop, left: node.scrollLeft })
    setSize({ width: node.clientWidth, height: node.clientHeight })
  }, [])

  useEffect(() => {
    const node = scroller.current
    props.onViewport?.(node)
    if (!node) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure, props.onViewport])

  // An axis that opens three weeks before the work starts reads as empty. Land on today once per
  // axis, then leave the reader's scrolling alone.
  const focused = useRef('')
  useEffect(() => {
    const node = scroller.current
    const column = props.focusColumn
    if (!node || column === undefined || column < 0) return
    const key = `${columnPx}:${days.length}:${days[0]?.stamp ?? 0}`
    if (focused.current === key) return
    focused.current = key
    node.scrollLeft = Math.max(0, column * columnPx - node.clientWidth / 3)
    measure()
  }, [columnPx, days, props.focusColumn, measure])

  const first = Math.max(0, Math.floor(offset.top / rowHeight) - BUFFER_ROWS)
  const last = Math.min(rowCount, Math.ceil((offset.top + size.height) / rowHeight) + BUFFER_ROWS)
  const indexes = Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index)
  const todayIndex = days.findIndex((day) => day.today)

  const months: { left: number, width: number, label: string }[] = []
  days.forEach((day, index) => {
    const label = new Date(day.stamp).toLocaleDateString(locale, { year: 'numeric', month: 'short' })
    const previous = months[months.length - 1]
    if (previous && previous.label === label) previous.width += columnPx
    else months.push({ left: index * columnPx, width: columnPx, label })
  })
  const visibleMonths = months.filter((month) => month.left + month.width > offset.left - HEAD_BUFFER_PX && month.left < offset.left + size.width + HEAD_BUFFER_PX)
  const firstDay = Math.max(0, Math.floor((offset.left - HEAD_BUFFER_PX) / columnPx))
  const lastDay = Math.min(days.length, Math.ceil((offset.left + size.width + HEAD_BUFFER_PX) / columnPx))
  const visibleDays = days.slice(firstDay, lastDay)

  const pan = (event: React.PointerEvent): void => {
    if (!props.panEnabled || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-schedule-bar]') || target.closest('button')) return
    const node = scroller.current
    if (!node) return
    const startX = event.clientX
    const startY = event.clientY
    const left = node.scrollLeft
    const top = node.scrollTop
    const move = (moveEvent: PointerEvent): void => {
      node.scrollLeft = left - (moveEvent.clientX - startX)
      node.scrollTop = top - (moveEvent.clientY - startY)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="pv-sched" data-schedule-frame="">
      <div className="pv-sched-head">
        <div className="pv-sched-corner">{props.corner}</div>
        <div className="pv-sched-headclip">
          <div className="pv-sched-headinner" style={{ width: `${totalWidth}px`, transform: `translateX(${-offset.left}px)` }}>
            {visibleMonths.map((month) => (
              <div key={`${month.label}-${month.left}`} className="pv-sched-month" style={{ left: `${month.left}px`, width: `${month.width}px` }}>{month.label}</div>
            ))}
            {visibleDays.map((day, index) => (
              <div
                key={day.stamp}
                className="pv-sched-unit"
                data-today={day.today}
                data-weekend={day.weekend}
                style={{ left: `${(firstDay + index) * columnPx}px`, width: `${columnPx}px` }}
              >
                {columnPx >= 22 ? new Date(day.stamp).getDate() : day.monthStart ? new Date(day.stamp).getDate() : ''}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="pv-sched-body">
        <div className="pv-sched-left">
          <div className="pv-sched-leftinner" style={{ height: `${totalHeight}px`, transform: `translateY(${-offset.top}px)` }}>
            {indexes.map((index) => props.renderLeftRow(index))}
          </div>
        </div>
        <div
          ref={scroller}
          className="pv-sched-scroll pv-scroll"
          data-pan={Boolean(props.panEnabled)}
          data-draw={Boolean(props.drawEnabled)}
          onScroll={measure}
          onPointerDown={(event) => {
            pan(event)
            if (!props.onCanvasPointerDown) return
            const node = scroller.current
            if (!node) return
            const rect = node.getBoundingClientRect()
            const x = event.clientX - rect.left + node.scrollLeft
            const y = event.clientY - rect.top + node.scrollTop
            props.onCanvasPointerDown(event, { column: Math.floor(x / columnPx), row: Math.floor(y / rowHeight) })
          }}
        >
          <div className="pv-sched-canvas" style={{ width: `${totalWidth}px`, height: `${Math.max(totalHeight, size.height)}px` }}>
            {showWeekends && visibleDays.map((day, index) => day.weekend
              ? <div key={`w-${day.stamp}`} className="pv-sched-weekend" style={{ left: `${(firstDay + index) * columnPx}px`, width: `${columnPx}px` }} aria-hidden="true" />
              : null)}
            {visibleDays.map((day, index) => (
              <div key={`v-${day.stamp}`} className="pv-sched-vline" style={{ left: `${(firstDay + index) * columnPx}px` }} aria-hidden="true" />
            ))}
            {indexes.map((index) => (
              <div key={`h-${index}`} className="pv-sched-hline" style={{ top: `${(index + 1) * rowHeight - 1}px` }} aria-hidden="true" />
            ))}
            {props.overlay?.({ first, last })}
            {showToday && todayIndex >= 0 && (
              <div className="pv-sched-today" style={{ left: `${todayIndex * columnPx}px` }} data-schedule-today="" aria-hidden="true" />
            )}
            {indexes.map((index) => props.renderRow(index))}
            {props.canvasExtra}
            {rowCount === 0 && props.emptyHint && <p className="pv-sched-hint">{props.emptyHint}</p>}
          </div>
        </div>
      </div>
    </div>
  )
}

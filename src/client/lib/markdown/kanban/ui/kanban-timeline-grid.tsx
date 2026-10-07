import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button, IconButton } from '../../../../components/primitives'
import { Segmented } from '../../../../components/form'
import { localeTag, t, useLocaleRepaint } from '../../../i18n'
import {
  buildTimelineRange,
  timelineTodayOffset,
  type TimelineDayFields,
  type TimelineRange,
  type TimelineZoom,
} from '../timeline-helpers'
import type { KanbanItem } from '../types'
import { KanbanIconBadge } from './kanban-icon-badge'
import { KanbanRenderTail, useKanbanRenderWindow } from './kanban-render-window'

/**
 * The scale the two time views share. It is deliberately not view state: the fences are what the
 * board's readers share, while how far out somebody likes to look is theirs alone — and every write
 * to a view is a write to the whole note (`write.ts`), which a control people toggle while reading
 * should not be paying for. What the board does keep is the scale itself, in `kanban-view-memory.ts`,
 * so looking at another view and coming back does not silently reset the reader to a day.
 */
export const TIMELINE_ZOOMS: TimelineZoom[] = ['day', 'week', 'month']

const ZOOM_LABELS: Record<TimelineZoom, 'preview.kanban_zoom_day' | 'preview.kanban_zoom_week' | 'preview.kanban_zoom_month'> = {
  day: 'preview.kanban_zoom_day',
  week: 'preview.kanban_zoom_week',
  month: 'preview.kanban_zoom_month',
}

export interface TimelineViewState {
  range: TimelineRange
  zoom: TimelineZoom
  scrollRef: RefObject<HTMLDivElement | null>
  onZoomChange: (zoom: TimelineZoom) => void
  onToday: () => void
}

/**
 * What both time views need to draw a grid: the window the cards ask for at the scale the reader
 * chose, the element the grid scrolls in, and the two controls that change either. The clock is read
 * again whenever the reader asks for today, so a board left open overnight is told the new date by
 * the same control that scrolls to it, and a scale change recentres on today because a new grid is a
 * new set of columns to find the reader's place in.
 *
 * The scale is handed in rather than owned here: it outlives this grid (the reader switching to the
 * board and back) and so belongs to the board's memory of how it was last left.
 */
export function useTimelineViewState(
  items: KanbanItem[],
  fields: TimelineDayFields | undefined,
  zoom: TimelineZoom,
  setZoom: (zoom: TimelineZoom) => void,
): TimelineViewState {
  const locale = localeTag()
  const [baseDate, setBaseDate] = useState(() => new Date())
  const range = useMemo(
    () => buildTimelineRange({ items, fields, zoom, baseDate, locale }),
    [items, fields, zoom, baseDate, locale],
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  useScrollToToday(scrollRef, range, baseDate)
  return {
    range,
    zoom,
    scrollRef,
    onZoomChange: (next) => {
      setZoom(next)
      setBaseDate(new Date())
    },
    onToday: () => setBaseDate(new Date()),
  }
}

/** The scale picker and the way back to today, over the grid they act on. */
export function TimelineRangeControls({
  zoom,
  onZoomChange,
  onToday,
}: {
  zoom: TimelineZoom
  onZoomChange: (zoom: TimelineZoom) => void
  onToday: () => void
}) {
  useLocaleRepaint()
  return (
    <div className='flex items-center justify-between gap-[var(--sp-3)] pb-[var(--sp-3)]'>
      <Segmented
        label={t('preview.kanban_timeline_scale')}
        size='sm'
        value={zoom}
        onChange={onZoomChange}
        options={TIMELINE_ZOOMS.map((value) => ({ value, label: t(ZOOM_LABELS[value]) }))}
      />
      <IconButton label={t('preview.kanban_timeline_today')} data-kanban-timeline-today size='sm' onClick={onToday}>
        <CalendarClock size={13} aria-hidden />
      </IconButton>
    </div>
  )
}

/**
 * Scrolls the grid so today's column is on screen, once when the view opens and whenever the control
 * asks. A window derived from the cards can be years wide, and today is the one column a reader
 * navigates by, so the view opens on it rather than at whichever edge the earliest card happened to
 * be. The reader's own scrolling is never taken back: this only runs when they ask or on mount.
 */
export function useScrollToToday(
  scrollRef: RefObject<HTMLDivElement | null>,
  range: TimelineRange,
  trigger: unknown,
): void {
  // The offset is read through a ref so the effect can be keyed on the trigger alone: a card edit
  // changes the range on every commit, and recentring the reader's scroll on each of those would make
  // the grid unusable while the board is being worked on.
  const rangeRef = useRef(range)
  rangeRef.current = range
  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    node.scrollLeft = Math.max(0, timelineTodayOffset(rangeRef.current) - node.clientWidth / 2)
  }, [scrollRef, trigger])
}

/** The month/period header over the grid, one cell per day, labelled at the current scale. */
export function TimelineDayHeader({ days, dayWidth }: { days: TimelineRange['days']; dayWidth: number }) {
  return (
    <div className='flex w-max border-b border-[var(--border-subtle)] bg-[var(--bg-raised)]'>
      {days.map((day) => (
        <div
          key={day.dateStr}
          data-timeline-day={day.dateStr}
          style={{ width: `${dayWidth}px` }}
          className='flex h-[var(--sp-12)] shrink-0 items-center justify-center overflow-hidden border-r border-[var(--border-subtle)] text-[length:var(--text-11)]'
        >
          {day.label !== '' && (
            <span
              className={
                day.isToday
                  ? 'rounded-full bg-[var(--accent)] px-[var(--sp-1-5)] py-[var(--sp-0-5)] font-bold text-[var(--accent-contrast)]'
                  : 'truncate text-[var(--text-tertiary)]'
              }
            >
              {day.label}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * What the grid cannot draw. A card with no day at all used to be painted on today's column, which
 * stated a date the card does not have; it is listed here instead, and the count is on the heading so
 * a reader who filtered the board down still sees how many cards the grid is not showing.
 */
export function TimelineUndatedList({
  items,
  onOpenDetail,
}: {
  items: KanbanItem[]
  onOpenDetail: (item: KanbanItem) => void
}) {
  useLocaleRepaint()
  // The heading counts the whole undated set; the rows are windowed like every other list, since a
  // board that is all undated cards is a thousand-row list here just as anywhere else.
  const { visible, hiddenCount, setTailElement, revealMore } = useKanbanRenderWindow(items)
  if (items.length === 0) return null
  return (
    <div data-kanban-timeline-undated className='border-t border-[var(--border-subtle)] bg-[var(--bg-raised)]'>
      <div className='px-[var(--sp-3)] py-[var(--sp-2)] text-[length:var(--text-11)] font-semibold text-[var(--text-tertiary)]'>
        {t('preview.kanban_timeline_undated', { count: items.length })}
      </div>
      <ul className='flex flex-col'>
        {visible.map((item) => (
          <li key={item.id}>
            <Button
              variant='ghost'
              size='sm'
              block
              icon={<KanbanIconBadge icon={item.icon} size={14} />}
              onClick={() => onOpenDetail(item)}
              className='justify-start rounded-none font-medium'
            >
              {item.title}
            </Button>
          </li>
        ))}
      </ul>
      <KanbanRenderTail hiddenCount={hiddenCount} setTailElement={setTailElement} onReveal={revealMore} />
    </div>
  )
}

/** Says out loud that the window is a part of the board, and how much of it. */
export function TimelineClippedNotice({ days }: { days: number }) {
  useLocaleRepaint()
  return (
    <p data-kanban-timeline-clipped role='status' className='pb-[var(--sp-2)] text-[length:var(--text-11)] text-[var(--text-tertiary)]'>
      {t('preview.kanban_timeline_clipped', { days })}
    </p>
  )
}


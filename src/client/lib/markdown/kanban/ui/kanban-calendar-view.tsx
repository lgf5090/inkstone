import { memo, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { t, useLocale } from '../../../i18n'
import { Segmented } from '../../../../components/form'
import { narrowWeekdayLabels, weekStartFor, type WeekStartDay } from '../../../time'
import { getMonthWeeks, getWeekDays, getWeekEventSegments, type CalendarDay, type WeekEventSegment } from '../calendar-helpers'
import { getKanbanTagStyle } from '../colors'
import { kanbanStatusColumn } from '../view-ops'
import type { KanbanData, KanbanItem, KanbanProperty, KanbanView } from '../types'
import { useKanbanDayMove } from './kanban-day-move'
import { KanbanIconBadge } from './kanban-icon-badge'

type CalendarMode = 'month' | 'week'

interface KanbanCalendarViewProps {
  data: KanbanData
  view?: KanbanView
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: (defaults?: Record<string, unknown>) => void
  /** The board's writer for a bar the reader moved to another day: one patch, one commit. */
  onMoveItem?: (itemId: string, patch: Record<string, string>) => void
}

interface CalendarHeaderProps {
  title: string
  mode: CalendarMode
  onModeChange: (mode: CalendarMode) => void
  onPrev: () => void
  onNext: () => void
  onToday: () => void
}

function CalendarHeader({ title, mode, onModeChange, onPrev, onNext, onToday }: CalendarHeaderProps) {
  return (
    <div className='flex items-center justify-between pb-3'>
      {/* The type goes on this wrapper, not on the heading: prose owns a note's `h3` and wins any
          utility written on it (see the hand-back block in `styles/kanban.css`). */}
      <div className='text-[length:var(--text-15)] font-semibold'>
        <h3 className='text-[var(--text-primary)]'>{title}</h3>
      </div>
      <div className='flex items-center gap-1.5'>
        {/* One radio group for the two spans the calendar can be read in; the arrows follow the
            span that is selected, so the control that moves a month never says "week". */}
        <Segmented
          value={mode}
          onChange={onModeChange}
          size='sm'
          label={t('preview.kanban_calendar_range')}
          options={[
            { value: 'month', label: t('preview.kanban_calendar_month') },
            { value: 'week', label: t('preview.kanban_calendar_week') },
          ]}
        />
        <button
          type='button'
          onClick={onToday}
          className='rounded-[var(--r-md)] border border-[var(--border-default)] px-2.5 py-1 text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
        >
          {t('preview.kanban_today')}
        </button>
        <button
          type='button'
          onClick={onPrev}
          className='inline-flex size-7 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
          aria-label={t(mode === 'week' ? 'preview.kanban_prev_week' : 'preview.kanban_prev_month')}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type='button'
          onClick={onNext}
          className='inline-flex size-7 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
          aria-label={t(mode === 'week' ? 'preview.kanban_next_week' : 'preview.kanban_next_month')}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

function CalendarWeekHeader({ locale, weekStart }: { locale: string; weekStart: WeekStartDay }) {
  return (
    <div className='grid grid-cols-7 border-b border-[var(--border-subtle)] pb-1 text-center text-[length:var(--text-12)] font-medium text-[var(--text-tertiary)]'>
      {narrowWeekdayLabels(locale, weekStart).map((label, index) => (
        <span key={(weekStart + index) % 7}>{label}</span>
      ))}
    </div>
  )
}

function CalendarEventBar({
  segment,
  statusCol,
  move,
  onOpenDetail,
}: {
  segment: WeekEventSegment
  statusCol?: KanbanProperty
  move: ReturnType<typeof useKanbanDayMove>
  onOpenDetail: (item: KanbanItem) => void
}) {
  const { item, startCol, endCol, isSegmentStart, isSegmentEnd, track } = segment
  const statusVal = String((statusCol ? item.properties[statusCol.id] : item.properties.status) || '')
  const statusOpt = statusCol?.options?.find((o) => o.id === statusVal || o.label === statusVal)
  const tagStyle = getKanbanTagStyle(statusOpt?.color || 'blue')

  const roundedLeft = isSegmentStart ? 'rounded-l-[var(--r-xs)]' : 'rounded-l-none'
  const roundedRight = isSegmentEnd ? 'rounded-r-[var(--r-xs)]' : 'rounded-r-none'

  const colSpan = endCol - startCol + 1

  return (
    <button
      type='button'
      data-item-id={item.id}
      {...move.barProps(item)}
      onKeyDown={(e) => move.barKeyDown(item, e)}
      onClick={(e) => {
        e.stopPropagation()
        onOpenDetail(item)
      }}
      style={{
        ...tagStyle,
        gridColumn: `${startCol + 1} / span ${colSpan}`,
        gridRow: track + 1,
      }}
      className={`z-10 flex h-6 cursor-grab touch-none items-center gap-1 overflow-hidden px-1.5 text-left text-[length:var(--text-11)] font-medium shadow-2xs transition-opacity hover:opacity-85 active:cursor-grabbing ${roundedLeft} ${roundedRight}`}
    >
      <KanbanIconBadge icon={item.icon} size={12} />
      <span className='truncate'>{item.title || t('preview.kanban_untitled')}</span>
    </button>
  )
}

function CalendarDayCellHeader({
  day,
  dateField,
  onAddItem,
}: {
  day: CalendarDay
  dateField?: string
  onAddItem: (defaults?: Record<string, unknown>) => void
}) {
  const addOnThisDay = () => onAddItem({ [dateField || 'startDate']: day.dateStr })
  return (
    // The cell is a container of two controls and both add an item to that day: the number is the one
    // a keyboard can reach, and the `+` beside it is the mouse affordance that appears on hover. As a
    // cell header that opened the day from its own click handler it was both unreachable without a
    // pointer and a click target holding a button of its own (SH-110).
    <div className='group/day flex items-center justify-between p-1.5 transition-colors hover:bg-[var(--bg-hover)]/30'>
      <button
        type='button'
        onClick={addOnThisDay}
        data-day={day.dateStr}
        aria-label={t('preview.kanban_new_item_on_value0', { value0: day.dayNum })}
        className={`cursor-pointer rounded-[var(--r-full)] text-[length:var(--text-12)] ${
          day.isToday
            ? 'flex size-5 items-center justify-center bg-[var(--accent)] font-bold text-[var(--accent-contrast)] shadow-2xs'
            : day.isCurrentMonth
            ? 'font-medium text-[var(--text-secondary)]'
            : 'text-[var(--text-quaternary)]'
        }`}
      >
        {day.dayNum}
      </button>
      <button
        type='button'
        onClick={addOnThisDay}
        className='cursor-pointer p-0.5 opacity-0 transition-opacity group-hover/day:opacity-100 focus-visible:opacity-100 pointer-coarse:!opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
        aria-label={t('preview.kanban_new_item')}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

function CalendarWeekRow({
  week,
  items,
  statusCol,
  dateField,
  move,
  onOpenDetail,
  onAddItem,
}: {
  week: CalendarDay[]
  items: KanbanItem[]
  statusCol?: KanbanProperty
  dateField?: string
  move: ReturnType<typeof useKanbanDayMove>
  onOpenDetail: (item: KanbanItem) => void
  onAddItem: (defaults?: Record<string, unknown>) => void
}) {
  const segments = useMemo(() => getWeekEventSegments(items, week, dateField), [items, week, dateField])

  return (
    <div className='relative flex min-h-24 flex-1 flex-col border-b border-[var(--border-subtle)] last:border-b-0'>
      <div className='pointer-events-none absolute inset-0 grid grid-cols-7 divide-x divide-[var(--border-subtle)]'>
        {week.map((day) => (
          <div
            key={day.dateStr}
            className={`${day.isCurrentMonth ? 'bg-[var(--bg-surface)]' : 'bg-[var(--bg-surface)] opacity-40'} ${
              day.isToday ? 'bg-[var(--accent-softer)]/30' : ''
            }`}
          />
        ))}
      </div>

      {/* The drop targets are the cells the reader sees, laid over the paint and under the bars: a
          drop lands on the day it was aimed at whether the week holds one bar or twenty. */}
      <div className='absolute inset-0 grid grid-cols-7 divide-x divide-[var(--border-subtle)]'>
        {week.map((day) => (
          <div key={day.dateStr} data-kanban-day-cell={day.dateStr} {...move.dayProps(day.dateStr)} />
        ))
        }
      </div>

      <div className='relative z-10 grid grid-cols-7'>
        {week.map((day) => (
          <CalendarDayCellHeader
            key={day.dateStr}
            day={day}
            dateField={dateField}
            onAddItem={onAddItem}
          />
        ))}
      </div>

      <div className='relative z-10 grid flex-1 grid-cols-7 auto-rows-max gap-y-1 px-1 pb-1'>
        {segments.map((seg) => (
          <CalendarEventBar
            key={`${seg.item.id}-${seg.startCol}`}
            segment={seg}
            statusCol={statusCol}
            move={move}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The week view's heading: the range its seven days actually cover, written the way the reader's
 * locale writes short dates — read off the days themselves, so the title cannot disagree with the
 * grid under it.
 */
function weekRangeTitle(locale: string, week: CalendarDay[]): string {
  const asUtc = (d: Date) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const yearFmt = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' })
  return t('preview.kanban_week_range', {
    value0: dayFmt.format(asUtc(week[0]!.date)),
    value1: dayFmt.format(asUtc(week[6]!.date)),
    value2: yearFmt.format(asUtc(week[6]!.date)),
  })
}

/** The date one step lands on: a whole week in week mode, one month in month mode. */
function stepCalendarDate(from: Date, mode: CalendarMode, direction: -1 | 1): Date {
  if (mode === 'week') {
    const moved = new Date(from)
    moved.setDate(moved.getDate() + direction * 7)
    return moved
  }
  return new Date(from.getFullYear(), from.getMonth() + direction, 1)
}

/**
 * The calendar's navigation state, kept apart from the drawing: which span the reader has it on,
 * where that span stands, the weeks it shows, and the heading that names it. Both spans are built
 * from the same week structure (`getMonthWeeks`'s rows, `getWeekDays` for the single one), so a
 * switch between them cannot make the title and the grid disagree.
 */
function useCalendarRange(locale: string, weekStart: WeekStartDay) {
  const [currentDate, setCurrentDate] = useState(() => new Date())
  const [mode, setMode] = useState<CalendarMode>('month')
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const weeks = useMemo(() => getMonthWeeks(year, month, weekStart), [year, month, weekStart])
  const weekDays = useMemo(
    () => (mode === 'week' ? getWeekDays(currentDate, weekStart) : null),
    [mode, currentDate, weekStart],
  )
  const visibleWeeks = weekDays ? [weekDays] : weeks
  const title = useMemo(
    () => (mode === 'week'
      ? weekRangeTitle(locale, weekDays!)
      : new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month, 1)))),
    [mode, locale, year, month, weekDays],
  )
  const step = (direction: -1 | 1) => setCurrentDate(stepCalendarDate(currentDate, mode, direction))
  const goToday = () => setCurrentDate(new Date())
  return { mode, setMode, title, visibleWeeks, step, goToday }
}

export const KanbanCalendarView = memo(function KanbanCalendarView({
  data,
  view,
  onOpenDetail,
  onAddItem,
  onMoveItem,
}: KanbanCalendarViewProps) {
  const locale = useLocale()
  const weekStart = weekStartFor(locale)
  const { mode, setMode, title, visibleWeeks, step, goToday } = useCalendarRange(locale, weekStart)
  const statusCol = kanbanStatusColumn(data.columns)
  const dateField = view?.dateField
  // The day-move gesture is only wired when the board can write; without a writer the drop targets
  // still exist but every patch is dropped on the floor, which is quieter than threading an optional
  // writer through three components.
  const move = useKanbanDayMove({ dateField, onMove: onMoveItem ?? (() => {}) })

  return (
    <div className='flex h-full w-full flex-col overflow-hidden p-4'>
      <CalendarHeader
        title={title}
        mode={mode}
        onModeChange={setMode}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onToday={goToday}
      />
      <CalendarWeekHeader locale={locale} weekStart={weekStart} />
      <div className='flex flex-1 flex-col overflow-y-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--border-subtle)]'>
        {visibleWeeks.map((week, idx) => (
          <CalendarWeekRow
            key={week[0].dateStr || idx}
            week={week}
            items={data.items}
            statusCol={statusCol}
            dateField={dateField}
            move={move}
            onOpenDetail={onOpenDetail}
            onAddItem={onAddItem}
          />
        ))}
      </div>
      {move.status}
    </div>
  )
})

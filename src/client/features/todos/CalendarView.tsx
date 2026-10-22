/**
 * The calendar: a month of bars and chips, and a week drawn against the clock.
 *
 * The month is a grid of days, but the thing being read is the *work*: a task that runs from Tuesday to
 * Thursday is one bar across three columns, not three unrelated titles. So each week row is its own
 * grid — cells underneath, a bar layer on top — and the lanes a row needs push its cells down.
 *
 * The week is the same tasks on an hour axis: all-day work in a strip at the top, timed work where it
 * falls, and the empty slots are real buttons so a press at 14:00 files a task at 14:00. Every surface
 * that shows a task can act on it: a chip opens the editor, a day opens its agenda, a drag moves the
 * due date, and a completed task leaves the view.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { localDate, toLocalMinute } from '@shared/assistant-time'
import type { TaskList, TodoTask } from '@shared/todos/model'
import { buildMonthGridCells, type MonthGridCell } from '../../components/calendar-grids'
import { Segmented } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { Button, IconButton } from '../../components/primitives'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/hooks'
import { localeTag, t, useLocale } from '../../lib/i18n'
import { useAlmanac, type AlmanacApi } from '../../lib/lunar/almanac-loader'
import { resolveDisplay, resolveWeekStart, useCalendarDisplayPrefs, type CalendarDisplayView } from '../../lib/calendar-display-prefs'
import {
  addDaysKey,
  dateKey,
  formatDateKey,
  narrowWeekdayLabels,
  startOfWeek,
  weekOrdinal,
  type WeekStartDay,
} from '../../lib/time'
import { useTodos } from './store'
import { TODO_DRAG_TYPE, isTodoTaskDrag, readTodoTaskDrag } from './TaskCard'
import { taskColorOf } from './task-face'
import {
  allDayTasksForDay,
  dayChips,
  spansForWeek,
  timeBlocksForDay,
  HOUR_H,
  minuteForSlot,
  minuteFromPointer,
  selectionFromDrag,
  slotCountFor,
  slotHeightFor,
  type CalendarZoom,
  type SpanBar,
} from './calendar-layout'
import { DayAgenda } from './DayAgenda'

type CalendarMode = 'month' | 'week'
type LoadState = 'loading' | 'ready' | 'error'

const CALENDAR_LIMIT = 500
const TITLES_PER_DAY = 3
const WEEK_LENGTH = 7
/** The date row a month cell reserves above its chips, and the height of one bar lane. */
const DAY_HEADER_H = 26
const LANE_H = 18
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
/** How far the pointer travels before a press on the axis counts as a drag rather than a click. */
const DRAG_SLOP_PX = 4

/** A box-select in progress: the column it started in, and where the pointer has got to. */
interface DragState {
  dayKey: string
  fromMinute: number
  toMinute: number
  /** The press's clientY, so a drag that never moved can be told from a click. */
  fromY: number
  /** The pressed column's box, so a pointer that wanders off still measures against it. */
  top: number
  height: number
}

interface WeekDayCell {
  key: string
  day: number
  inMonth: boolean
  today: boolean
  date: Date
}

function shiftDays(date: Date, delta: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + delta)
  return next
}

function shiftMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1)
}

function weekCells(anchor: Date, weekStart: WeekStartDay, todayKey: string): WeekDayCell[] {
  const start = startOfWeek(anchor, weekStart)
  return Array.from({ length: WEEK_LENGTH }, (_, index) => {
    const date = shiftDays(start, index)
    const key = dateKey(date)
    return { key, day: date.getDate(), inMonth: true, today: key === todayKey, date }
  })
}

function monthTitle(date: Date): string {
  return new Intl.DateTimeFormat(localeTag(), { year: 'numeric', month: 'long' }).format(date)
}

function dayLabel(key: string, count: number): string {
  // The count is always spoken, including zero: a screen reader should not have to infer an empty day
  // from a label that suddenly loses half of its shape.
  return t('todo.calendar.day_aria', { date: formatDateKey(key), count })
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** A minute of the day as the clock reads it, for the instants a slot or a selection names. */
function mmClock(minute: number): string {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`
}

/** The clock time a task reads at, or null for an all-day one. */
function timeOf(task: TodoTask, timezone: string): string | null {
  if (task.dueAt === null) return null
  const minute = toLocalMinute(task.dueAt, timezone)
  return minute.endsWith('T23:59') ? null : minute.slice(11)
}

/** A chip is one task on one day; a bar is one task across several. Both open the task. */
function TaskChip({ task, color, time, dragEnabled, onOpen }: {
  task: TodoTask
  color: string
  time: string | null
  dragEnabled: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      draggable={dragEnabled ? true : undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(TODO_DRAG_TYPE, task.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onOpen}
      title={task.title}
      className="flex w-full min-w-0 items-center gap-1 rounded-[var(--r-xs)] px-0.5 py-px text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    >
      <span className="h-2.5 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {time && <span className="shrink-0 tabular text-[length:var(--text-9)] text-[var(--text-quaternary)]">{time}</span>}
      <span className="truncate text-[length:var(--text-10-5)] leading-tight text-[var(--text-secondary)]">{task.title}</span>
    </button>
  )
}

/** The bar a task covering several days draws across one week's columns. */
function SpanRow({ bar, color, weekStart, weekEnd, timezone, dragEnabled, onOpen }: {
  bar: SpanBar
  color: string
  weekStart: string
  weekEnd: string
  timezone: string
  dragEnabled: boolean
  onOpen: () => void
}) {
  const start = bar.task.startAt != null ? localDate(bar.task.startAt, timezone) : null
  const end = bar.task.dueAt != null ? localDate(bar.task.dueAt, timezone) : null
  // The rounded ends are the ends of the task, not of the week: a bar that continues past Sunday is
  // cut flat on that side so it reads as continuing.
  const openLeft = start !== null && start < weekStart
  const openRight = end !== null && end > weekEnd
  return (
    <button
      type="button"
      draggable={dragEnabled ? true : undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(TODO_DRAG_TYPE, bar.task.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onOpen}
      title={bar.task.title}
      data-calendar-span={bar.task.id}
      style={{ gridColumn: `${bar.startCol + 1} / ${bar.endCol + 2}`, gridRow: `${bar.lane + 1}` }}
      className={cn(
        'pointer-events-auto relative mx-0.5 flex h-4 min-w-0 items-center gap-1 px-1 text-left text-[length:var(--text-10)] leading-none',
        'text-[var(--text-primary)] transition-colors hover:brightness-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        openLeft ? 'rounded-l-none' : 'rounded-l-[var(--r-xs)]',
        openRight ? 'rounded-r-none' : 'rounded-r-[var(--r-xs)]',
      )}
    >
      <span
        className="absolute inset-0 rounded-[inherit]"
        style={{ backgroundColor: `color-mix(in oklab, ${color} 18%, var(--bg-surface))` }}
        aria-hidden="true"
      />
      <span className="relative z-10 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="relative z-10 truncate">{bar.task.title}</span>
    </button>
  )
}

/**
 * One week of the month: cells, and the bars that cross them.
 *
 * The bars live in their own grid laid over the cells, sharing the same columns and gap, so a bar that
 * names columns 1–3 lands exactly on those three days without any pixel arithmetic.
 */
function MonthWeek({ cells, tasks, lists, timezone, compact, almanac, display, dragEnabled, onOpenDay, onAdd, onOpenTask, onReschedule, focusKey, onFocus }: {
  cells: readonly MonthGridCell[]
  tasks: readonly TodoTask[]
  lists: readonly TaskList[]
  timezone: string
  compact: boolean
  almanac: AlmanacApi | null
  display: CalendarDisplayView
  dragEnabled: boolean
  onOpenDay: (key: string) => void
  onAdd: (key: string) => void
  onOpenTask: (task: TodoTask) => void
  onReschedule: (taskId: string, dayKey: string) => void
  focusKey: string | null
  onFocus: (key: string) => void
}) {
  const [dropKey, setDropKey] = useState<string | null>(null)
  const weekKeys = useMemo(() => cells.map((cell) => cell.key), [cells])
  const spans = useMemo(() => spansForWeek(tasks, weekKeys, timezone), [tasks, weekKeys, timezone])
  const lanes = spans.reduce((max, bar) => Math.max(max, bar.lane + 1), 0)
  /** How many bars start on each column, so a day's spoken count includes them. */
  const spanStarts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const bar of spans) {
      const key = weekKeys[bar.startCol]
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [spans, weekKeys])

  return (
    <div className="relative">
      <div className="grid grid-cols-7 gap-[var(--sp-0-5)]">
        {cells.map((cell) => {
          const chips = dayChips(tasks, cell.key, timezone)
          const shown = chips.slice(0, TITLES_PER_DAY)
          const hidden = chips.length - shown.length
          const almanacDay = cell.inMonth ? almanac?.almanacOf(cell.date) ?? null : null
          const named = display.festivals ? almanacDay?.highlight ?? null : null
          const almanacText = named ? almanacDay?.highlightShort ?? named : display.lunar ? almanacDay?.short ?? null : null
          const weekend = display.weekendTint && cell.inMonth && chips.length === 0
            && (cell.date.getDay() === 0 || cell.date.getDay() === 6)
          if (!cell.inMonth && !display.showAdjacentDays) {
            return <span key={cell.key} aria-hidden="true" className="min-h-[64px] w-full rounded-[var(--r-md)] bg-[var(--bg-sunken)]/40 md:min-h-[104px]" />
          }
          return (
            <div
              key={cell.key}
              data-calendar-cell={cell.key}
              onDragOver={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropKey(cell.key)
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                  setDropKey((current) => (current === cell.key ? null : current))
                }
              }}
              onDrop={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                setDropKey(null)
                const dragged = readTodoTaskDrag(event)
                if (dragged) onReschedule(dragged, cell.key)
              }}
              className={cn(
                'group relative flex min-w-0 flex-col gap-0.5 rounded-[var(--r-md)] border p-1',
                cell.inMonth
                  ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)]'
                  : 'border-transparent bg-[var(--bg-sunken)]/60',
                weekend && 'bg-[var(--bg-sunken)]',
                cell.today && 'ring-1 ring-inset ring-[var(--accent)]',
                dropKey === cell.key && 'border-[var(--accent)] ring-1 ring-[var(--accent)]',
                compact ? 'min-h-[64px]' : 'min-h-[104px]',
              )}
              style={{ paddingTop: DAY_HEADER_H + lanes * LANE_H }}
            >
              <button
                type="button"
                data-calendar-day={cell.key}
                tabIndex={cell.key === focusKey ? 0 : -1}
                aria-label={dayLabel(cell.key, chips.length + (spanStarts.get(cell.key) ?? 0))}
                onClick={() => onOpenDay(cell.key)}
                onFocus={() => onFocus(cell.key)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  onOpenDay(cell.key)
                }}
                className={cn(
                  'absolute inset-x-1 top-1 flex min-w-0 items-center gap-1 rounded-[var(--r-xs)] px-0.5 text-left',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                  cell.inMonth ? 'text-[var(--text-primary)]' : 'text-[var(--text-quaternary)]',
                )}
              >
                <span className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full tabular text-[length:var(--text-11)]',
                  cell.today ? 'bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]' : 'text-[var(--text-secondary)]',
                )}>{cell.day}</span>
                {almanacText && (
                  <span className={cn('min-w-0 truncate text-[length:var(--text-8-5)] leading-tight', named ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
                    {almanacText}
                  </span>
                )}
              </button>
              {cell.inMonth && (
                <button
                  type="button"
                  aria-label={t('todo.calendar.add_on_day')}
                  onClick={() => onAdd(cell.key)}
                  className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] group-hover:opacity-100"
                >
                  <Plus size={11} />
                </button>
              )}
              {compact ? (
                chips.length > 0 && (
                  <span className="mt-auto flex w-full min-w-0 items-center gap-0.5 pt-1">
                    {chips.slice(0, 3).map((task) => (
                      <span key={task.id} className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: taskColorOf(task, lists) }} aria-hidden="true" />
                    ))}
                    {chips.length > 3 && <span className="text-[length:var(--text-8-5)] leading-none text-[var(--text-quaternary)]">+{chips.length - 3}</span>}
                  </span>
                )
              ) : (
                <>
                  {shown.map((task) => (
                    <TaskChip
                      key={task.id}
                      task={task}
                      color={taskColorOf(task, lists)}
                      time={timeOf(task, timezone)}
                      dragEnabled={dragEnabled}
                      onOpen={() => onOpenTask(task)}
                    />
                  ))}
                  {hidden > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenDay(cell.key)}
                      className="px-0.5 text-left text-[length:var(--text-9)] leading-tight text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                    >
                      +{hidden}
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      {spans.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 grid grid-cols-7 gap-[var(--sp-0-5)]"
          style={{ top: DAY_HEADER_H, gridAutoRows: `${LANE_H}px` }}
        >
          {spans.map((bar) => (
            <SpanRow
              key={bar.task.id}
              bar={bar}
              color={taskColorOf(bar.task, lists)}
              weekStart={weekKeys[0]!}
              weekEnd={weekKeys[weekKeys.length - 1]!}
              timezone={timezone}
              dragEnabled={dragEnabled}
              onOpen={() => onOpenTask(bar.task)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The week, drawn against the clock.
 *
 * The all-day strip is a row of its own, because a task with no time is not "at 00:00" — it is due that
 * day. Below it, every slot is a real button, so a press on the 14:00 slot of Thursday files a task at
 * 14:00 rather than asking the reader to type the time afterwards. The slots divide the same 24 hours
 * either by the hour or by the half, which is a reading preference and not a second calendar.
 */
function WeekTimeGrid({ week, tasks, lists, timezone, todayKey, now, dragEnabled, zoom, onOpenDay, onAdd, onOpenTask, onReschedule }: {
  week: readonly WeekDayCell[]
  tasks: readonly TodoTask[]
  lists: readonly TaskList[]
  timezone: string
  todayKey: string
  now: number
  dragEnabled: boolean
  zoom: CalendarZoom
  onOpenDay: (key: string) => void
  /** A slot press names one minute; a box-select names the range it drew. */
  onAdd: (key: string, startMinute?: number, endMinute?: number) => void
  onOpenTask: (task: TodoTask) => void
  /** `null` makes the task all-day; a number lands it at that hour. */
  onReschedule: (taskId: string, dayKey: string, hour: number | null) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  /** The box-select being drawn, or null when the pointer is only passing through. */
  const [drag, setDrag] = useState<DragState | null>(null)
  /**
   * Set when a box-select has just created a task, so the click that follows the same press — the
   * pointer went down and came up inside one slot — does not create a second one at that slot.
   * A ref because nothing renders on it: it is cleared by the next press, which every click in
   * this column is preceded by.
   */
  const suppressClick = useRef(false)
  // The working day is where a calendar should open; midnight is a scroll away in both directions.
  // `scrollTo` is absent in jsdom, where this is a render rather than a layout.
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 7 * HOUR_H })
  }, [])
  /**
   * The drag listens on the window rather than on the column it started in, so a selection survives
   * a pointer that wanders off that column while it is down — the column stays where the range is
   * measured, which is also what keeps a drag from ever creating across two days.
   */
  useEffect(() => {
    if (!drag) return
    const finish = (clientY: number): void => {
      const minute = minuteFromPointer(clientY - drag.top, drag.height)
      const selection = Math.abs(clientY - drag.fromY) >= DRAG_SLOP_PX
        ? selectionFromDrag({ zoom, fromMinute: drag.fromMinute, toMinute: minute })
        : null
      // A press that never travelled is a click on the slot under it, and that slot's own button
      // answers it; creating here as well would file the task twice.
      if (selection) {
        suppressClick.current = true
        onAdd(drag.dayKey, selection.startMinute, selection.endMinute)
      }
      setDrag(null)
    }
    const onMove = (event: PointerEvent): void => {
      setDrag((current) => (current
        ? { ...current, toMinute: minuteFromPointer(event.clientY - current.top, current.height) }
        : current))
    }
    const onUp = (event: PointerEvent): void => finish(event.clientY)
    const onCancel = (): void => setDrag(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // The press that armed the drag still ends in a click on its slot, so cancelling the
      // selection has to swallow that click too — otherwise Esc cancels the range and files the
      // task the slot's own button would have created on a plain press.
      suppressClick.current = true
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [drag, zoom, onAdd])
  const nowMinute = useMemo(() => {
    const minute = toLocalMinute(now, timezone)
    const [hour, min] = minute.slice(11).split(':').map(Number)
    return (hour ?? 0) * 60 + (min ?? 0)
  }, [now, timezone])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-[40px_repeat(7,minmax(0,1fr))] border-b border-[var(--border-subtle)]">
        <span aria-hidden="true" />
        {week.map((day) => (
          <button
            key={day.key}
            type="button"
            data-calendar-day={day.key}
            onClick={() => onOpenDay(day.key)}
            className="flex min-w-0 flex-col items-center gap-0.5 py-1 hover:bg-[var(--bg-hover)]"
          >
            <span className="text-[length:var(--text-9)] uppercase text-[var(--text-quaternary)]">
              {new Intl.DateTimeFormat(localeTag(), { weekday: 'short' }).format(day.date)}
            </span>
            <span className={cn(
              'flex size-6 items-center justify-center rounded-full tabular text-[length:var(--text-12)]',
              day.today ? 'bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]' : 'text-[var(--text-secondary)]',
            )}>{day.day}</span>
          </button>
        ))}
      </div>
      <div className="grid shrink-0 grid-cols-[40px_repeat(7,minmax(0,1fr))] border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]/40">
        <span className="py-1 pr-1 text-right text-[length:var(--text-8-5)] text-[var(--text-quaternary)]">{t('todo.calendar.all_day')}</span>
        {week.map((day) => {
          const allDay = allDayTasksForDay(tasks, day.key, timezone)
          return (
            <div
              key={day.key}
              className={cn('flex min-h-9 min-w-0 flex-col gap-0.5 border-l border-[var(--border-subtle)] p-0.5', dropKey === day.key && 'bg-[var(--accent-soft)]')}
              onDragOver={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                setDropKey(day.key)
              }}
              onDragLeave={() => setDropKey((current) => (current === day.key ? null : current))}
              onDrop={(event) => {
                if (!isTodoTaskDrag(event)) return
                event.preventDefault()
                setDropKey(null)
                const dragged = readTodoTaskDrag(event)
                if (dragged) onReschedule(dragged, day.key, null)
              }}
            >
              {allDay.slice(0, 3).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  draggable={dragEnabled ? true : undefined}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(TODO_DRAG_TYPE, task.id)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onOpenTask(task)}
                  className="flex min-w-0 items-center gap-1 rounded-[var(--r-xs)] px-1 py-0.5 text-left text-[length:var(--text-10)] hover:bg-[var(--bg-hover)]"
                  style={{ backgroundColor: `color-mix(in oklab, ${taskColorOf(task, lists)} 14%, transparent)` }}
                >
                  <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: taskColorOf(task, lists) }} aria-hidden="true" />
                  <span className="truncate text-[var(--text-secondary)]">{task.title}</span>
                </button>
              ))}
              {allDay.length > 3 && (
                <button type="button" onClick={() => onOpenDay(day.key)} className="px-1 text-left text-[length:var(--text-9)] text-[var(--text-tertiary)]">
                  +{allDay.length - 3}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <div ref={scroller} className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div
          className="grid grid-cols-[40px_repeat(7,minmax(0,1fr))]"
          style={{ height: 24 * HOUR_H, '--slot-h': `${slotHeightFor(zoom)}px` } as React.CSSProperties}
        >
          <div aria-hidden="true">
            {HOURS.map((hour) => (
              <div key={hour} className="relative h-11 pr-1 text-right text-[length:var(--text-9)] tabular text-[var(--text-quaternary)]">
                <span className="absolute -top-1 right-1">{hour === 0 ? '' : `${pad2(hour)}:00`}</span>
              </div>
            ))}
          </div>
          {week.map((day) => {
            const blocks = timeBlocksForDay(tasks, day.key, timezone)
            const lanes = blocks.reduce((max, block) => Math.max(max, block.lane + 1), 1)
            /**
             * Arms a box-select on the column.
             *
             * The slots tile the column, so the press itself cannot tell a drag from a click — the
             * pointer's travel does. A press on a task block is left alone: that block carries its
             * own HTML5 drag to move the task, and one press must not answer to both.
             */
            const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
              if (!dragEnabled || event.button !== 0) return
              const target = event.target
              if (target instanceof Element && target.closest('[data-calendar-block]')) return
              const rect = event.currentTarget.getBoundingClientRect()
              const minute = minuteFromPointer(event.clientY - rect.top, rect.height)
              suppressClick.current = false
              setDrag({ dayKey: day.key, fromMinute: minute, toMinute: minute, fromY: event.clientY, top: rect.top, height: rect.height })
            }
            return (
              <div
                key={day.key}
                className="relative border-l border-[var(--border-subtle)]"
                onPointerDown={startDrag}
                onDragOver={(event) => {
                  if (!isTodoTaskDrag(event)) return
                  event.preventDefault()
                  setDropKey(day.key)
                }}
                onDragLeave={() => setDropKey((current) => (current === day.key ? null : current))}
                onDrop={(event) => {
                  if (!isTodoTaskDrag(event)) return
                  event.preventDefault()
                  const rect = event.currentTarget.getBoundingClientRect()
                  const hour = Math.max(0, Math.min(23, Math.floor(((event.clientY - rect.top) / rect.height) * 24)))
                  setDropKey(null)
                  const dragged = readTodoTaskDrag(event)
                  if (dragged) onReschedule(dragged, day.key, hour)
                }}
              >
                {Array.from({ length: slotCountFor(zoom) }, (_, index) => minuteForSlot(zoom, index)).map((minute) => (
                  <button
                    key={minute}
                    type="button"
                    aria-label={t('todo.calendar.add_at', { date: formatDateKey(day.key), time: mmClock(minute) })}
                    onClick={() => {
                      // A box-select that ended inside this slot has already filed the task; the
                      // click that follows the same press is its echo, not a second request.
                      if (suppressClick.current) {
                        suppressClick.current = false
                        return
                      }
                      onAdd(day.key, minute)
                    }}
                    className="block h-[var(--slot-h)] w-full border-b border-[var(--border-subtle)]/60 transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--accent-soft)] focus-visible:outline-none"
                  />
                ))}
                {drag !== null && drag.dayKey === day.key && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 rounded-[var(--r-xs)] bg-[var(--accent-soft)]"
                    style={{
                      top: (Math.min(drag.fromMinute, drag.toMinute) / 60) * HOUR_H,
                      height: Math.max(2, (Math.abs(drag.toMinute - drag.fromMinute) / 60) * HOUR_H),
                    }}
                  />
                )}
                {day.key === todayKey && (
                  <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10" style={{ top: (nowMinute / 60) * HOUR_H }}>
                    <span className="absolute -left-0.5 size-1.5 -translate-y-1/2 rounded-full bg-[var(--danger)]" />
                    <span className="block h-px bg-[var(--danger)]" />
                  </span>
                )}
                {blocks.map((block) => (
                  <button
                    key={block.task.id}
                    type="button"
                    draggable={dragEnabled ? true : undefined}
                    data-calendar-block={block.task.id}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(TODO_DRAG_TYPE, block.task.id)
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onClick={() => onOpenTask(block.task)}
                    title={block.task.title}
                    className="absolute z-10 flex flex-col overflow-hidden rounded-[var(--r-xs)] px-1 py-0.5 text-left text-[length:var(--text-10)] shadow-[var(--shadow-xs)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                    style={{
                      top: (block.startMin / 60) * HOUR_H,
                      height: Math.max(18, ((block.endMin - block.startMin) / 60) * HOUR_H - 2),
                      left: `calc(${(block.lane / lanes) * 100}% + 1px)`,
                      width: `calc(${100 / lanes}% - 2px)`,
                      backgroundColor: `color-mix(in oklab, ${taskColorOf(block.task, lists)} 16%, var(--bg-surface))`,
                      borderLeft: `2px solid ${taskColorOf(block.task, lists)}`,
                    }}
                  >
                    <span className="truncate font-medium text-[var(--text-primary)]">{block.task.title}</span>
                    <span className="truncate tabular text-[length:var(--text-9)] text-[var(--text-tertiary)]">
                      {`${pad2(Math.floor(block.startMin / 60))}:${pad2(block.startMin % 60)}`}
                    </span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function CalendarView() {
  const timezone = useTodos((state) => state.timezone)
  const lists = useTodos((state) => state.lists)
  const openEditor = useTodos((state) => state.openEditor)
  const editorOpen = useTodos((state) => state.editorOpen)
  const toggleTask = useTodos((state) => state.toggleTask)
  const updateTask = useTodos((state) => state.updateTask)
  const locale = useLocale()
  const wide = useMediaQuery('(min-width: 1024px)')
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)')
  const prefs = useCalendarDisplayPrefs()
  const weekStart = resolveWeekStart(prefs.weekStart, locale)
  const display = useMemo(() => resolveDisplay(prefs, locale), [prefs, locale])
  const almanac = useAlmanac(display.lunar || display.festivals)
  const weekdayLabels = useMemo(() => narrowWeekdayLabels(locale, weekStart), [locale, weekStart])
  const todayKey = useMemo(() => localDate(Date.now(), timezone), [timezone])

  const [mode, setMode] = useState<CalendarMode>('month')
  /**
   * How finely the week's hour axis is divided. A reading of the axis, not a setting: it is not
   * persisted and does not travel with the account, so switching a device cannot surprise the reader
   * with a week redrawn at a granularity they never chose here.
   */
  const [zoom, setZoom] = useState<CalendarZoom>('hour')
  const [anchor, setAnchor] = useState(() => new Date())
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [agendaKey, setAgendaKey] = useState<string | null>(null)

  const monthCells = useMemo(
    () => buildMonthGridCells(anchor.getFullYear(), anchor.getMonth(), weekStart, todayKey),
    [anchor, weekStart, todayKey],
  )
  const week = useMemo(() => weekCells(anchor, weekStart, todayKey), [anchor, weekStart, todayKey])
  const cells = mode === 'month' ? monthCells : week
  const firstKey = cells[0]!.key
  const lastKey = cells[cells.length - 1]!.key
  const dueFrom = `${firstKey}T00:00`
  const dueTo = `${addDaysKey(lastKey, 1)}T00:00`

  const focusCells = useMemo(() => (mode === 'month' ? monthCells.filter((cell) => cell.inMonth) : week), [mode, monthCells, week])
  const defaultFocusKey = useMemo(
    () => focusCells.find((cell) => cell.today)?.key ?? focusCells[0]?.key ?? null,
    [focusCells],
  )
  const activeFocusKey = focusKey && cells.some((cell) => cell.key === focusKey) ? focusKey : defaultFocusKey

  const sequence = useRef(0)
  useEffect(() => {
    const id = ++sequence.current
    setStatus('loading')
    setError(null)
    api.todos.list({ view: 'open', dueFrom, dueTo, limit: CALENDAR_LIMIT })
      .then((page) => {
        if (id !== sequence.current) return
        setTasks(page.tasks)
        setStatus('ready')
      })
      .catch((failure: unknown) => {
        if (id !== sequence.current) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setStatus('error')
      })
  }, [dueFrom, dueTo, reloadToken])

  const editorWasOpen = useRef(false)
  useEffect(() => {
    if (editorWasOpen.current && !editorOpen) setReloadToken((token) => token + 1)
    editorWasOpen.current = editorOpen
  }, [editorOpen])

  const title = mode === 'month' ? monthTitle(anchor) : `${formatDateKey(week[0]!.key)} – ${formatDateKey(week[WEEK_LENGTH - 1]!.key)}`

  const move = (delta: number): void => {
    setAnchor((current) => (mode === 'month' ? shiftMonths(current, delta) : shiftDays(current, delta * WEEK_LENGTH)))
  }

  const goToday = useCallback((): void => {
    setAnchor(new Date())
    setFocusKey(todayKey)
  }, [todayKey])

  // `t` is the calendar's own shortcut: the container answers Escape and the views' letters, and a
  // page that scrolls a year at a time needs one key back to the day it is being read on.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== 't') return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      goToday()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [goToday])

  const onGridKeyDown = (event: ReactKeyboardEvent<Element>): void => {
    const step = event.key === 'ArrowLeft' ? -1
      : event.key === 'ArrowRight' ? 1
        : mode === 'month' && event.key === 'ArrowUp' ? -WEEK_LENGTH
          : mode === 'month' && event.key === 'ArrowDown' ? WEEK_LENGTH
            : 0
    if (!step) return
    const start = cells.findIndex((cell) => cell.key === activeFocusKey)
    const next = cells[Math.min(cells.length - 1, Math.max(0, (start < 0 ? 0 : start) + step))]
    if (!next) return
    event.preventDefault()
    setFocusKey(next.key)
    event.currentTarget.querySelector<HTMLElement>(`[data-calendar-day="${next.key}"]`)?.focus()
  }

  const retry = (): void => setReloadToken((token) => token + 1)
  const openDay = (key: string): void => setAgendaKey(key)
  /**
   * Opens the editor on a day, on one minute of it, or on a range the week's axis selected.
   *
   * A bare day and a lone minute are the two presses the axis has always answered; a range carries
   * both ends so the editor opens with the start already named rather than asking for it after.
   */
  const addOnDay = useCallback((key: string, startMinute?: number, endMinute?: number): void => {
    setAgendaKey(null)
    if (startMinute !== undefined && endMinute !== undefined) {
      openEditor({ startAt: `${key}T${mmClock(startMinute)}`, dueAt: `${key}T${mmClock(endMinute)}` })
      return
    }
    openEditor({ dueAt: startMinute === undefined ? key : `${key}T${mmClock(startMinute)}` })
  }, [openEditor])
  const openTask = (task: TodoTask): void => openEditor({ id: task.id })

  const completeTask = async (task: TodoTask): Promise<void> => {
    await toggleTask(task)
    setReloadToken((token) => token + 1)
  }

  /**
   * Moves a task to another day, keeping the clock time it already had.
   *
   * A drop on a day keeps "09:00" as 09:00 on the new day; a drop on an hour slot moves it to that hour;
   * a drop on the all-day strip clears the time. Each is the reader saying which of the three they meant.
   */
  const reschedule = async (taskId: string, dayKey: string, hour?: number | null): Promise<void> => {
    const task = tasks.find((entry) => entry.id === taskId)
    if (!task) return
    const original = task.dueAt === null ? null : toLocalMinute(task.dueAt, timezone)
    const clock = hour === null
      ? null
      : hour !== undefined
        ? `${pad2(hour)}:00`
        : original && !original.endsWith('T23:59') ? original.slice(11) : null
    const dueAt = clock === null ? dayKey : `${dayKey}T${clock}`
    const landed = await updateTask(task.id, { dueAt })
    if (landed) setReloadToken((token) => token + 1)
  }

  const weeks = useMemo(() => {
    const rows: MonthGridCell[][] = []
    for (let index = 0; index < monthCells.length; index += WEEK_LENGTH) rows.push(monthCells.slice(index, index + WEEK_LENGTH))
    return rows
  }, [monthCells])
  const showWeekNumbers = display.weekNumbers && wide

  const body = status === 'error'
    ? (
      <div role="alert" className="flex-1 px-4 py-10">
        <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('todo.calendar.error')}</p>
        {error && <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{error}</p>}
        <Button size="lg" className="mt-3 min-h-11" onClick={retry}>{t('common.retry')}</Button>
      </div>
    )
    : status === 'loading'
      ? <LoadingBlock />
      : (
        <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
          {tasks.length === 0 && (
            <p className="mx-3 mb-2 flex items-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)] md:mx-5">
              <CalendarDays size={13} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t('todo.empty.plan')} · {t('todo.empty.plan_hint')}</span>
            </p>
          )}
          {mode === 'month' ? (
            <div
              role="group"
              aria-label={`${t('todo.view.calendar')} · ${title}`}
              onKeyDown={onGridKeyDown}
              className="flex flex-col gap-[var(--sp-0-5)] px-2 pb-4 pt-1 md:px-4"
            >
              <div className={cn('grid gap-[var(--sp-0-5)]', showWeekNumbers ? 'grid-cols-[18px_repeat(7,minmax(0,1fr))]' : 'grid-cols-7')}>
                {showWeekNumbers && <span aria-hidden="true" />}
                {weekdayLabels.map((label, index) => (
                  <div key={index} className="flex items-center justify-center py-1 text-[length:var(--text-9)] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-quaternary)]">
                    {label}
                  </div>
                ))}
              </div>
              {weeks.map((row) => (
                <div key={row[0]!.key} className={cn('grid gap-[var(--sp-0-5)]', showWeekNumbers ? 'grid-cols-[18px_repeat(7,minmax(0,1fr))]' : 'grid-cols-7')}>
                  {showWeekNumbers && (
                    <span aria-hidden="true" className="flex items-start justify-center pt-1 text-[length:var(--text-8-5)] tabular text-[var(--text-quaternary)]">
                      {weekOrdinal(row[0]!.date, weekStart).week}
                    </span>
                  )}
                  <div className="col-span-7">
                    <MonthWeek
                      cells={row}
                      tasks={tasks}
                      lists={lists}
                      timezone={timezone}
                      compact={!wide}
                      almanac={almanac}
                      display={display}
                      dragEnabled={finePointer}
                      onOpenDay={openDay}
                      onAdd={(key) => addOnDay(key)}
                      onOpenTask={openTask}
                      onReschedule={(id, key) => { void reschedule(id, key) }}
                      focusKey={activeFocusKey}
                      onFocus={setFocusKey}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <WeekTimeGrid
              week={week}
              tasks={tasks}
              lists={lists}
              timezone={timezone}
              todayKey={todayKey}
              now={Date.now()}
              dragEnabled={finePointer}
              zoom={zoom}
              onOpenDay={openDay}
              onAdd={addOnDay}
              onOpenTask={openTask}
              onReschedule={(id, key, hour) => { void reschedule(id, key, hour) }}
            />
          )}
        </div>
      )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-todo-calendar={mode}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-3 md:px-5">
        <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">{title}</h2>
        <div className="flex items-center gap-1.5">
          <Segmented
            value={mode}
            onChange={setMode}
            size="md"
            label={t('todo.view.calendar')}
            options={[
              { value: 'month', label: t('preview.kanban_calendar_month') },
              { value: 'week', label: t('preview.kanban_calendar_week') },
            ]}
          />
          {mode === 'week' && (
            <Segmented
              value={zoom}
              onChange={setZoom}
              size="md"
              label={t('todo.calendar.zoom')}
              options={[
                { value: 'hour', label: t('todo.calendar.zoom_hour') },
                { value: 'half', label: t('todo.calendar.zoom_half') },
              ]}
            />
          )}
          <Button variant="secondary" onClick={goToday}>{t('preview.kanban_today')}</Button>
          <IconButton label={t('todo.calendar.previous')} size="sm" className="size-11 md:size-7" onClick={() => move(-1)}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label={t('todo.calendar.next')} size="sm" className="size-11 md:size-7" onClick={() => move(1)}>
            <ChevronRight size={15} />
          </IconButton>
          <IconButton label={t('todo.action.new_task')} size="sm" className="size-11 md:size-7" onClick={() => addOnDay(todayKey)}>
            <CalendarPlus size={15} />
          </IconButton>
        </div>
      </div>
      {mode === 'week' && (
        <p className="shrink-0 px-3 pb-1.5 text-[length:var(--text-9)] text-[var(--text-quaternary)] md:px-5">{t('todo.calendar.drag_hint')}</p>
      )}
      {body}
      <DayAgenda
        open={agendaKey !== null}
        dayKey={agendaKey}
        tasks={tasks}
        lists={lists}
        timezone={timezone}
        wide={wide}
        onClose={() => setAgendaKey(null)}
        onOpenTask={openTask}
        onToggle={(task) => { void completeTask(task) }}
        onAdd={(key) => addOnDay(key)}
      />
    </div>
  )
}

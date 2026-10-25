/**
 * The mini month: 42 cells, event dots in calendar colours, and a date that drives the main view.
 *
 * It reads DayFlow's registry and events directly rather than keeping a second copy of the data, so
 * a visibility toggle or a drag in the main grid is reflected here on the next app notification.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Temporal } from 'temporal-polyfill'
import type { Event, ICalendarApp } from '@dayflow/react'
import { cn } from '../../lib/cn'
import { useLocale, t } from '../../lib/i18n'
import { narrowWeekdayLabels, type WeekStartDay } from '../../lib/time'
import { useThemeDark } from '../../lib/hooks'
import { IconButton } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { eventDateInZone } from './model'

const CELL_COUNT = 42
const MAX_DOTS = 4

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

function startOfWeek(date: Date, weekStart: number): Date {
  const day = date.getDay()
  return addDays(date, -((day - weekStart + 7) % 7))
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function plainDateKey(date: Temporal.PlainDate): string {
  return date.toString()
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function visibleCalendarIds(app: ICalendarApp): Set<string> {
  return new Set(app.getCalendars().filter(calendar => calendar.isVisible !== false).map(calendar => calendar.id))
}

function eventColors(events: Event[], app: ICalendarApp, timeZone: string, dark: boolean): Map<string, string[]> {
  const visible = visibleCalendarIds(app)
  const dots = new Map<string, string[]>()
  for (const event of events) {
    const ids = event.calendarIds?.length ? event.calendarIds : event.calendarId ? [event.calendarId] : []
    if (!ids.some(id => visible.has(id))) continue
    const color = app.getCalendarRegistry().resolveColors(ids[0], dark ? 'dark' : 'light').lineColor
    const from = eventDateInZone(event.start, timeZone)
    const to = eventDateInZone(event.end, timeZone)
    let cursor = from
    let guard = 0
    while (Temporal.PlainDate.compare(cursor, to) <= 0 && guard < 370) {
      const key = plainDateKey(cursor)
      const colors = dots.get(key) ?? []
      if (!colors.includes(color) && colors.length < MAX_DOTS) colors.push(color)
      dots.set(key, colors)
      cursor = cursor.add({ days: 1 })
      guard += 1
    }
  }
  return dots
}

interface MiniMonthProps {
  app: ICalendarApp
  currentDate: Date
  weekStart: number
  timeZone: string
  showEventDots: boolean
  /** Bumped by the sidebar on every app notification, so event edits refresh the dots. */
  version: number
  onSelectDate: (date: Date) => void
}

export function MiniMonth({ app, currentDate, weekStart, timeZone, showEventDots, version, onSelectDate }: MiniMonthProps) {
  const locale = useLocale()
  const dark = useThemeDark()
  const today = startOfDay(new Date())
  const [displayMonth, setDisplayMonth] = useState(() => startOfMonth(currentDate))
  const cellsRef = useRef(new Map<string, HTMLButtonElement>())
  const currentMonthKey = `${currentDate.getFullYear()}-${currentDate.getMonth()}`
  const selectedKey = dateKey(currentDate)

  useEffect(() => {
    setDisplayMonth(startOfMonth(currentDate))
    // A date picked in the main grid should bring the mini month back to that month.
  }, [currentMonthKey])

  const days = useMemo(() => {
    const first = startOfWeek(startOfMonth(displayMonth), weekStart)
    return Array.from({ length: CELL_COUNT }, (_, index) => addDays(first, index))
  }, [displayMonth, weekStart])

  const dots = useMemo(
    () => (showEventDots ? eventColors(app.getEvents(), app, timeZone, dark) : new Map<string, string[]>()),
    [app, timeZone, dark, showEventDots, version],
  )

  const weekdays = useMemo(
    () => narrowWeekdayLabels(locale, weekStart as WeekStartDay).map((label, index) => ({ key: index, label })),
    [locale, weekStart],
  )

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(displayMonth),
    [locale, displayMonth],
  )

  const tabKey = days.some(day => dateKey(day) === selectedKey && day.getMonth() === displayMonth.getMonth())
    ? selectedKey
    : dateKey(days[0] ?? displayMonth)

  const moveFocus = (day: Date, event: KeyboardEvent<HTMLButtonElement>, delta: number): void => {
    event.preventDefault()
    const next = addDays(day, delta)
    onSelectDate(next)
    window.setTimeout(() => cellsRef.current.get(dateKey(next))?.focus({ preventScroll: true }), 0)
  }

  return (
    <section aria-label={t('calendar.a11y.mini_calendar')} className="px-2 pt-2">
      <div className="mb-1 flex items-center gap-1">
        <IconButton
          size="sm"
          label={t('calendar.sidebar.previous_month')}
          onClick={() => setDisplayMonth(month => addMonths(month, -1))}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </IconButton>
        <span aria-live="polite" className="min-w-0 flex-1 truncate text-center text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
          {monthLabel}
        </span>
        <IconButton
          size="sm"
          label={t('calendar.sidebar.next_month')}
          onClick={() => setDisplayMonth(month => addMonths(month, 1))}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <div role="grid" aria-label={t('calendar.a11y.mini_calendar')} className="text-center">
        <div role="row" className="grid grid-cols-7">
          {weekdays.map(day => (
            <span key={day.key} role="columnheader" className="py-1 text-[length:var(--text-10)] font-medium text-[var(--text-quaternary)]">
              {day.label}
            </span>
          ))}
        </div>
        {Array.from({ length: CELL_COUNT / 7 }, (_, row) => (
          <div key={row} role="row" className="grid grid-cols-7">
            {days.slice(row * 7, row * 7 + 7).map((day) => {
              const key = dateKey(day)
              const selected = key === selectedKey
              const inMonth = day.getMonth() === displayMonth.getMonth()
              const dayDots = dots.get(key) ?? []
              const formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              return (
                <button
                  key={key}
                  ref={(node) => {
                    if (node) cellsRef.current.set(key, node)
                    else cellsRef.current.delete(key)
                  }}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={formatter.format(day)}
                  tabIndex={key === tabKey ? 0 : -1}
                  onClick={() => onSelectDate(day)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') moveFocus(day, event, -1)
                    else if (event.key === 'ArrowRight') moveFocus(day, event, 1)
                    else if (event.key === 'ArrowUp') moveFocus(day, event, -7)
                    else if (event.key === 'ArrowDown') moveFocus(day, event, 7)
                  }}
                  className={cn(
                    'relative mx-auto flex h-7 w-7 flex-col items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-11-5)]',
                    'transition-colors duration-[var(--dur-fast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                    inMonth ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]',
                    isSameDay(day, today) && !selected && 'font-semibold text-[var(--accent)]',
                    selected ? 'bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]' : 'hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <span>{day.getDate()}</span>
                  {showEventDots && dayDots.length > 0 && (
                    <span className="mt-[1px] flex h-[3px] items-center justify-center gap-[2px]" aria-hidden="true">
                      {dayDots.map(color => (
                        <span key={color} className="size-[3px] rounded-full" style={{ backgroundColor: color }} />
                      ))}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="mt-1 flex justify-center">
        <Tooltip label={t('calendar.sidebar.today')}>
          <button
            type="button"
            onClick={() => onSelectDate(new Date())}
            className="rounded-[var(--r-sm)] px-2 py-0.5 text-[length:var(--text-11-5)] font-medium text-[var(--accent)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            {t('calendar.sidebar.today')}
          </button>
        </Tooltip>
      </div>
    </section>
  )
}

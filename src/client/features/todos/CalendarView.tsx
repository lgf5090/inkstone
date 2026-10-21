import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { localDate, toLocalMinute } from '@shared/assistant-time'
import type { TodoTask } from '@shared/todos/model'
import { MonthGrid, buildMonthGridCells } from '../../components/calendar-grids'
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

type CalendarMode = 'month' | 'week'
type LoadState = 'loading' | 'ready' | 'error'

const CALENDAR_LIMIT = 500
const TITLES_PER_DAY = 3
const WEEK_LENGTH = 7

interface CalendarDayCell {
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

function weekCells(anchor: Date, weekStart: WeekStartDay, todayKey: string): CalendarDayCell[] {
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

function CalendarDay({ cell, tasks, weekday, focusable, tall, compact, almanac, display, colorOf, timeOf, onActivate, onFocus }: {
  cell: CalendarDayCell
  tasks: readonly TodoTask[]
  weekday?: string
  focusable: boolean
  tall?: boolean
  compact?: boolean
  almanac: AlmanacApi | null
  display: CalendarDisplayView
  colorOf: (task: TodoTask) => string
  timeOf: (task: TodoTask) => string | null
  onActivate: (key: string) => void
  onFocus: (key: string) => void
}) {
  if (!cell.inMonth && !display.showAdjacentDays) {
    return <span aria-hidden="true" className={cn('w-full rounded-[var(--r-md)] bg-[var(--bg-sunken)]/40', tall ? 'min-h-48' : compact ? 'min-h-[72px]' : 'min-h-24')} />
  }
  const shown = tasks.slice(0, TITLES_PER_DAY)
  const hidden = tasks.length - shown.length
  const almanacDay = cell.inMonth ? almanac?.almanacOf(cell.date) ?? null : null
  const named = display.festivals ? almanacDay?.highlight ?? null : null
  const almanacText = named ? almanacDay?.highlightShort ?? named : display.lunar ? almanacDay?.short ?? null : null
  const weekend = display.weekendTint && cell.inMonth && tasks.length === 0
    && (cell.date.getDay() === 0 || cell.date.getDay() === 6)
  const compactMonth = compact && !tall
  return (
    <button
      type="button"
      data-calendar-day={cell.key}
      tabIndex={focusable ? 0 : -1}
      aria-label={dayLabel(cell.key, tasks.length)}
      onClick={() => onActivate(cell.key)}
      onFocus={() => onFocus(cell.key)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        onActivate(cell.key)
      }}
      className={cn(
        'group flex w-full min-w-0 flex-col items-stretch gap-0.5 overflow-hidden rounded-[var(--r-md)] border p-1.5 text-left align-top',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        cell.inMonth
          ? 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          : 'border-transparent bg-[var(--bg-sunken)]/60 text-[var(--text-quaternary)]',
        weekend && 'bg-[var(--bg-sunken)]',
        cell.today && 'ring-1 ring-inset ring-[var(--accent)]',
        tall ? 'min-h-48' : compactMonth ? 'min-h-[72px]' : 'min-h-24',
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1">
        {weekday && <span className="shrink-0 text-[length:var(--text-9)] font-medium uppercase text-[var(--text-quaternary)]">{weekday}</span>}
        <span className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full tabular text-[length:var(--text-11)]',
          cell.today ? 'bg-[var(--accent)] font-semibold text-[var(--accent-contrast)]' : 'text-[var(--text-secondary)]',
        )}>{cell.day}</span>
        <span aria-hidden="true" className="ml-auto hidden shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 md:inline">
          <Plus size={11} />
        </span>
      </span>
      {almanacText && (
        <span className={cn('w-full truncate text-[length:var(--text-8-5)] leading-tight', named ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
          {almanacText}
        </span>
      )}
      {compactMonth ? (
        tasks.length > 0 && (
          <span className="mt-auto flex w-full min-w-0 items-center gap-0.5 pt-1">
            {tasks.slice(0, 3).map((task) => (
              <span key={task.id} className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(task) }} aria-hidden="true" />
            ))}
            {tasks.length > 3 && <span className="text-[length:var(--text-8)] leading-none text-[var(--text-quaternary)]">+{tasks.length - 3}</span>}
          </span>
        )
      ) : (
        <>
          {shown.map((task) => (
            <span key={task.id} className="flex w-full min-w-0 items-center gap-1.5">
              <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: colorOf(task) }} aria-hidden="true" />
              {tall && timeOf(task) && <span className="shrink-0 tabular text-[length:var(--text-9)] text-[var(--text-quaternary)]">{timeOf(task)}</span>}
              <span className="truncate text-[length:var(--text-10-5)] leading-tight text-[var(--text-secondary)]">{task.title}</span>
            </span>
          ))}
          {hidden > 0 && <span className="text-[length:var(--text-9)] leading-tight text-[var(--text-tertiary)]">+{hidden}</span>}
        </>
      )}
    </button>
  )
}

export function CalendarView() {
  const timezone = useTodos((state) => state.timezone)
  const lists = useTodos((state) => state.lists)
  const openEditor = useTodos((state) => state.openEditor)
  const editorOpen = useTodos((state) => state.editorOpen)
  const locale = useLocale()
  const wide = useMediaQuery('(min-width: 1024px)')
  const prefs = useCalendarDisplayPrefs()
  const weekStart = resolveWeekStart(prefs.weekStart, locale)
  const display = useMemo(() => resolveDisplay(prefs, locale), [prefs, locale])
  const almanac = useAlmanac(display.lunar || display.festivals)
  const weekdayLabels = useMemo(() => narrowWeekdayLabels(locale, weekStart), [locale, weekStart])
  const todayKey = useMemo(() => localDate(Date.now(), timezone), [timezone])

  const [mode, setMode] = useState<CalendarMode>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [focusKey, setFocusKey] = useState<string | null>(null)

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

  const byDay = useMemo(() => {
    const grouped = new Map<string, TodoTask[]>()
    for (const task of tasks) {
      if (task.dueAt === null) continue
      const key = localDate(task.dueAt, timezone)
      const rows = grouped.get(key)
      if (rows) rows.push(task)
      else grouped.set(key, [task])
    }
    for (const rows of grouped.values()) rows.sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0))
    return grouped
  }, [tasks, timezone])

  const colorOf = useMemo(() => (task: TodoTask): string => {
    if (!task.listId) return 'var(--text-tertiary)'
    return lists.find((list) => list.id === task.listId)?.color ?? 'var(--accent)'
  }, [lists])

  const timeOf = useMemo(() => (task: TodoTask): string | null => {
    if (task.dueAt === null) return null
    const minute = toLocalMinute(task.dueAt, timezone)
    return minute.endsWith('T23:59') ? null : minute.slice(11)
  }, [timezone])

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

  const goToday = (): void => {
    setAnchor(new Date())
    setFocusKey(todayKey)
  }

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
  const activateDay = (key: string): void => openEditor({ dueAt: key })

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
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
          {tasks.length === 0 && (
            <p className="mx-3 mb-2 flex items-center gap-1.5 rounded-[var(--r-md)] border border-dashed border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-12)] text-[var(--text-tertiary)] md:mx-5">
              <CalendarDays size={13} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t('todo.empty.plan')} · {t('todo.empty.plan_hint')}</span>
            </p>
          )}
          {mode === 'month' ? (
            <MonthGrid
              year={anchor.getFullYear()}
              month={anchor.getMonth()}
              weekStart={weekStart}
              weekdayLabels={weekdayLabels}
              todayKey={todayKey}
              ariaLabel={`${t('todo.view.calendar')} · ${title}`}
              onKeyDown={onGridKeyDown}
              className="px-3 pb-4 pt-1 md:px-5"
              renderRowHeader={display.weekNumbers && wide
                ? (_rowIndex, row) => {
                    const { week: weekNumber } = weekOrdinal(row[0]!.date, weekStart)
                    return (
                      <span aria-hidden="true" className="flex items-center justify-center text-[length:var(--text-8-5)] tabular text-[var(--text-quaternary)]">
                        {weekNumber}
                      </span>
                    )
                  }
                : undefined}
              renderCell={(cell) => (
                <CalendarDay
                  cell={cell}
                  tasks={byDay.get(cell.key) ?? []}
                  focusable={cell.key === activeFocusKey}
                  compact={!wide}
                  almanac={almanac}
                  display={display}
                  colorOf={colorOf}
                  timeOf={timeOf}
                  onActivate={activateDay}
                  onFocus={setFocusKey}
                />
              )}
            />
          ) : (
            <div className="no-scrollbar overflow-x-auto">
              <div
                role="group"
                aria-label={`${t('todo.view.calendar')} · ${title}`}
                onKeyDown={onGridKeyDown}
                className={cn('grid grid-cols-7 gap-[var(--sp-0-5)] px-3 pb-4 md:px-5', !wide && 'min-w-[840px]')}
              >
                {week.map((cell, index) => (
                  <CalendarDay
                    key={cell.key}
                    cell={cell}
                    tasks={byDay.get(cell.key) ?? []}
                    weekday={weekdayLabels[index]}
                    focusable={cell.key === activeFocusKey}
                    tall
                    compact={!wide}
                    almanac={almanac}
                    display={display}
                    colorOf={colorOf}
                    timeOf={timeOf}
                    onActivate={activateDay}
                    onFocus={setFocusKey}
                  />
                ))}
              </div>
            </div>
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
          <Button variant="secondary" onClick={goToday}>{t('preview.kanban_today')}</Button>
          <IconButton label={t('todo.calendar.previous')} size="sm" className="size-11 md:size-7" onClick={() => move(-1)}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label={t('todo.calendar.next')} size="sm" className="size-11 md:size-7" onClick={() => move(1)}>
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>
      {body}
    </div>
  )
}

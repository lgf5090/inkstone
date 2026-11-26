/**
 * The timeline: one open task per row, measured from its start to its due day.
 *
 * A missing start is inferred backwards from the estimate when there is one; a missing due day is
 * inferred forwards. A task with no estimate keeps a one-day, dashed placeholder instead of inventing a
 * duration. The bar and its two ends are real buttons: the bar opens the task and moves the whole range,
 * while either end adjusts that date. Arrow keys give the same edits without a pointer.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { localDate, toLocalMinute } from '@shared/assistant-time'
import { formatTaskDuration } from '@shared/todos/duration'
import { MAX_TASKS_PER_QUERY, type TodoTask } from '@shared/todos/model'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { localeTag, t } from '../../lib/i18n'
import { formatDateKey } from '../../lib/time'
import { Button, IconButton } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { shiftDay, weekStart } from './due-range'
import { taskColorOf } from './task-face'
import { useTodos, type TodoTimelineScale } from './store'

const DAY_MS = 86_400_000
const DAY_WIDTH = 44
const ROW_HEIGHT = 44
const BAR_HEIGHT = 28
const DRAG_THRESHOLD_PX = 4

type LoadState = 'loading' | 'ready' | 'error'
type DragMode = 'move' | 'start' | 'end'

export interface TimelineRange {
  /** First included account-zone day. */
  from: string
  /** First excluded account-zone day. */
  to: string
}

export interface TimelineBar {
  task: TodoTask
  start: string
  end: string
  startExplicit: boolean
  endExplicit: boolean
  /** The row has a positive estimate, so its inferred or explicit span is a plan rather than a placeholder. */
  estimated: boolean
}

interface ActiveDrag {
  task: TodoTask
  mode: DragMode
  startX: number
  days: number
  moved: boolean
  pointerId: number
}

/** The week or calendar month containing an account-zone day. */
export function timelineRangeFor(day: string, scale: TodoTimelineScale): TimelineRange {
  if (scale === 'week') {
    const from = weekStart(day)
    return { from, to: shiftDay(from, 7) }
  }
  const from = `${day.slice(0, 7)}-01`
  const date = new Date(`${from}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return { from, to: date.toISOString().slice(0, 10) }
}

/** Move a timeline window by one of its own units. */
export function shiftTimelineRange(range: TimelineRange, scale: TodoTimelineScale, delta: number): TimelineRange {
  if (scale === 'week') {
    const from = shiftDay(range.from, delta * 7)
    return { from, to: shiftDay(from, 7) }
  }
  const date = new Date(`${range.from}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + delta)
  const from = date.toISOString().slice(0, 10)
  const next = new Date(`${from}T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + 1)
  return { from, to: next.toISOString().slice(0, 10) }
}

/** Every included day in a half-open range. */
export function timelineDays(range: TimelineRange): string[] {
  const days: string[] = []
  for (let day = range.from; day < range.to; day = shiftDay(day, 1)) days.push(day)
  return days
}

/**
 * The days one task's bar covers.
 *
 * Explicit start and due dates win. The estimate fills only a missing end, rounded up to a whole day;
 * without an estimate the bar is a visible one-day placeholder. A reversed explicit range is clamped
 * rather than drawn backwards.
 */
export function timelineBarFor(task: TodoTask, timezone: string): TimelineBar | null {
  const explicitStart = task.startAt != null ? localDate(task.startAt, timezone) : null
  const explicitEnd = task.dueAt != null ? localDate(task.dueAt, timezone) : null
  if (explicitStart === null && explicitEnd === null) return null
  const estimate = task.timeEstimateMs ?? null
  const estimateDays = estimate !== null && estimate > 0 ? Math.max(1, Math.ceil(estimate / DAY_MS)) : 0
  let start: string
  let end: string
  if (explicitStart !== null && explicitEnd !== null) {
    start = explicitStart > explicitEnd ? explicitEnd : explicitStart
    end = explicitEnd
  } else if (explicitEnd !== null) {
    end = explicitEnd
    start = estimateDays > 0 ? shiftDay(end, -estimateDays) : end
  } else {
    start = explicitStart!
    end = estimateDays > 0 ? shiftDay(start, estimateDays - 1) : start
  }
  return {
    task,
    start,
    end,
    startExplicit: explicitStart !== null,
    endExplicit: explicitEnd !== null,
    estimated: estimateDays > 0,
  }
}

/** Whether a bar touches the half-open window. */
export function timelineBarOverlaps(bar: TimelineBar, range: TimelineRange): boolean {
  return bar.end >= range.from && bar.start < range.to
}

/** The inclusive day distance between two account-zone days. */
function dayDistance(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/** The bar while a pointer is moving it, before anything is written. */
function draggedBar(bar: TimelineBar, drag: ActiveDrag): TimelineBar {
  if (drag.days === 0) return bar
  if (drag.mode === 'move') {
    return { ...bar, start: shiftDay(bar.start, drag.days), end: shiftDay(bar.end, drag.days) }
  }
  if (drag.mode === 'start') {
    const start = shiftDay(bar.start, drag.days)
    return { ...bar, start: start > bar.end ? bar.end : start }
  }
  return { ...bar, end: shiftDay(bar.end, drag.days) < bar.start ? bar.start : shiftDay(bar.end, drag.days) }
}

/** Keep an existing wall-clock time when a drag changes only its day. */
function shiftedDateValue(instant: number | null | undefined, day: string, timezone: string): string {
  if (instant == null) return day
  const minute = toLocalMinute(instant, timezone)
  return minute.endsWith('T23:59') ? day : `${day}T${minute.slice(11)}`
}

/** The patch one committed drag means. Whole-bar moves preserve which ends were actually stated. */
function timelinePatch(task: TodoTask, bar: TimelineBar, mode: DragMode, days: number, timezone: string): Record<string, unknown> {
  if (mode === 'start') {
    const start = shiftDay(bar.start, days)
    return { startAt: shiftedDateValue(task.startAt, start > bar.end ? bar.end : start, timezone) }
  }
  if (mode === 'end') {
    const end = shiftDay(bar.end, days)
    return { dueAt: shiftedDateValue(task.dueAt, end < bar.start ? bar.start : end, timezone) }
  }
  const patch: Record<string, unknown> = {}
  if (bar.startExplicit) patch.startAt = shiftedDateValue(task.startAt, shiftDay(bar.start, days), timezone)
  if (bar.endExplicit) patch.dueAt = shiftedDateValue(task.dueAt, shiftDay(bar.end, days), timezone)
  return patch
}

function barLabel(bar: TimelineBar): string {
  const estimate = bar.task.timeEstimateMs != null && bar.task.timeEstimateMs > 0
    ? formatTaskDuration(bar.task.timeEstimateMs)
    : t('todo.time.none')
  return `${bar.task.title} · ${formatDateKey(bar.start)} – ${formatDateKey(bar.end)} · ${estimate}`
}

export function TimelineView() {
  const lists = useTodos((state) => state.lists)
  const timezone = useTodos((state) => state.timezone)
  const openEditor = useTodos((state) => state.openEditor)
  const editorOpen = useTodos((state) => state.editorOpen)
  const updateTask = useTodos((state) => state.updateTask)
  const timelineFrom = useTodos((state) => state.timelineFrom)
  const timelineTo = useTodos((state) => state.timelineTo)
  const timelineScale = useTodos((state) => state.timelineScale)
  const setTimelineRange = useTodos((state) => state.setTimelineRange)

  const [tasks, setTasks] = useState<TodoTask[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [announcement, setAnnouncement] = useState('')
  const dragRef = useRef<ActiveDrag | null>(null)
  const [drag, setDrag] = useState<ActiveDrag | null>(null)
  const suppressClick = useRef(false)

  const today = localDate(Date.now(), timezone)
  const scale = timelineScale ?? 'week'
  const range = useMemo<TimelineRange>(() => (
    timelineFrom && timelineTo && timelineFrom < timelineTo
      ? { from: timelineFrom, to: timelineTo }
      : timelineRangeFor(today, scale)
  ), [timelineFrom, timelineTo, today, scale])
  const days = useMemo(() => timelineDays(range), [range])

  const sequence = useRef(0)
  useEffect(() => {
    const id = ++sequence.current
    setStatus('loading')
    setError(null)
    // Start-only and undated tasks have no server-side start filter. Reading the open set once keeps the
    // range switch local and lets the timeline place those rows honestly; the ceiling is reported below.
    api.todos.list({ view: 'open', sort: 'due', limit: MAX_TASKS_PER_QUERY })
      .then((page) => {
        if (id !== sequence.current) return
        setTasks(page.tasks)
        setTotal(page.total)
        setStatus('ready')
      })
      .catch((failure: unknown) => {
        if (id !== sequence.current) return
        setError(failure instanceof Error ? failure.message : String(failure))
        setStatus('error')
      })
  }, [reloadToken])

  const editorWasOpen = useRef(false)
  useEffect(() => {
    if (editorWasOpen.current && !editorOpen) setReloadToken((token) => token + 1)
    editorWasOpen.current = editorOpen
  }, [editorOpen])

  const bars = useMemo(() => tasks
    .map((task) => timelineBarFor(task, timezone))
    .filter((bar): bar is TimelineBar => bar !== null && timelineBarOverlaps(bar, range))
    .toSorted((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end)
      || left.task.title.localeCompare(right.task.title)), [tasks, timezone, range])
  const unscheduled = useMemo(() => tasks.filter((task) => timelineBarFor(task, timezone) === null), [tasks, timezone])

  const commit = useCallback(async (task: TodoTask, bar: TimelineBar, mode: DragMode, days: number): Promise<void> => {
    if (days === 0) return
    const patch = timelinePatch(task, bar, mode, days, timezone)
    if (Object.keys(patch).length === 0) return
    const landed = await updateTask(task.id, patch, task.rev)
    if (!landed) return
    setTasks((current) => current.map((entry) => entry.id === landed.id ? landed : entry))
    const moved = mode === 'start' ? landed.startAt : mode === 'end' ? landed.dueAt : landed.dueAt ?? landed.startAt
    if (moved != null) setAnnouncement(t('preview.kanban_moved_to_date', { title: task.title, date: formatDateKey(localDate(moved, timezone)) }))
  }, [timezone, updateTask])

  const startDrag = (event: ReactPointerEvent<HTMLElement>, task: TodoTask, mode: DragMode): void => {
    if (event.button !== 0) return
    event.stopPropagation()
    const next: ActiveDrag = { task, mode, startX: event.clientX, days: 0, moved: false, pointerId: event.pointerId }
    dragRef.current = next
    suppressClick.current = false
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDrag(next)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    const distance = event.clientX - current.startX
    if (!current.moved && Math.abs(distance) < DRAG_THRESHOLD_PX) return
    const next = { ...current, moved: true, days: Math.round(distance / DAY_WIDTH) }
    dragRef.current = next
    setDrag(next)
  }

  const endDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false): void => {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    dragRef.current = null
    setDrag(null)
    suppressClick.current = current.moved
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (!cancelled && current.moved) {
      const bar = timelineBarFor(current.task, timezone)
      if (bar) void commit(current.task, bar, current.mode, current.days)
    }
  }

  const keyboardDelta = (event: ReactKeyboardEvent): number => {
    const step = event.shiftKey ? 7 : 1
    return event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
  }

  const moveRange = (delta: number): void => {
    setTimelineRange({ ...shiftTimelineRange(range, scale, delta), scale })
  }
  const changeScale = (next: TodoTimelineScale): void => {
    setTimelineRange({ ...timelineRangeFor(range.from, next), scale: next })
  }
  const goToday = (): void => setTimelineRange({ ...timelineRangeFor(today, scale), scale })
  const retry = (): void => setReloadToken((token) => token + 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-todo-timeline={scale}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pb-2 pt-3 md:px-5">
        <h2 className="min-w-0 truncate text-[length:var(--text-15)] font-semibold tracking-[-0.012em] text-[var(--text-primary)]">
          {`${formatDateKey(range.from)} – ${formatDateKey(shiftDay(range.to, -1))}`}
        </h2>
        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <Segmented
            value={scale}
            onChange={changeScale}
            size="md"
            label={t('project.view.scale')}
            options={[
              { value: 'week', label: t('preview.kanban_calendar_week') },
              { value: 'month', label: t('preview.kanban_calendar_month') },
            ]}
          />
          <Button variant="secondary" onClick={goToday}>{t('project.view.today')}</Button>
          <IconButton label={t('todo.calendar.previous')} size="sm" className="size-11 md:size-7" onClick={() => moveRange(-1)}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label={t('todo.calendar.next')} size="sm" className="size-11 md:size-7" onClick={() => moveRange(1)}>
            <ChevronRight size={15} />
          </IconButton>
        </div>
      </div>

      {status === 'error' ? (
        <div role="alert" className="flex flex-1 flex-col items-start gap-2 px-4 py-10">
          <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('todo.error.load')}</p>
          <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('todo.error.load_hint')}</p>
          {error && <p className="break-words text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{error}</p>}
          <Button onClick={retry}>{t('common.retry')}</Button>
        </div>
      ) : status === 'loading' ? (
        <LoadingBlock />
      ) : (
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-24 md:px-5 md:pb-6">
          {total > tasks.length && (
            <p role="status" className="mb-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)]/40 px-3 py-2 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
              {t('todo.focus.history.more', { count: total - tasks.length })}
            </p>
          )}
          {bars.length === 0 && unscheduled.length === 0 ? (
            <Empty title={t('todo.empty.plan')} description={t('todo.empty.plan_hint')} compact />
          ) : (
            <>
              {bars.length > 0 && (
                <div
                  role="group"
                  aria-label={t('preview.kanban_view_timeline')}
                  tabIndex={0}
                  className="overflow-x-auto rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  <div className="flex w-max min-w-full border-b border-[var(--border-subtle)] bg-[var(--bg-raised)]">
                    <div className="sticky left-0 z-[var(--z-sticky)] flex w-56 shrink-0 items-center border-r border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11)] font-semibold text-[var(--text-secondary)]">
                      {t('preview.kanban_task_name')}
                    </div>
                    <div className="flex">
                      {days.map((day) => (
                        <div
                          key={day}
                          data-timeline-day={day}
                          className={cn(
                            'flex shrink-0 flex-col items-center justify-center border-r border-[var(--border-subtle)] py-1 tabular',
                            day === today && 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]',
                          )}
                          style={{ width: DAY_WIDTH }}
                        >
                          <span className="text-[length:var(--text-8-5)] text-[var(--text-quaternary)]">
                            {new Intl.DateTimeFormat(localeTag(), { weekday: 'narrow' }).format(new Date(`${day}T00:00:00Z`))}
                          </span>
                          <span className="text-[length:var(--text-10-5)] font-medium">{day.slice(8)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {bars.map((bar) => {
                    const shown = drag?.task.id === bar.task.id ? draggedBar(bar, drag) : bar
                    const first = Math.max(0, dayDistance(range.from, shown.start))
                    const last = Math.min(days.length - 1, dayDistance(range.from, shown.end))
                    const width = Math.max(1, last - first + 1) * DAY_WIDTH
                    const color = taskColorOf(bar.task, lists)
                    const pointerProps = (mode: DragMode) => ({
                      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startDrag(event, bar.task, mode),
                      onPointerMove: moveDrag,
                      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => endDrag(event),
                      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => endDrag(event, true),
                    })
                    return (
                      <div key={bar.task.id} className="flex min-h-11 border-b border-[var(--border-subtle)] last:border-b-0" style={{ height: ROW_HEIGHT }} data-timeline-row={bar.task.id}>
                        <div className="sticky left-0 z-[var(--z-sticky)] flex w-56 shrink-0 flex-col justify-center border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3">
                          <span className="truncate text-[length:var(--text-11-5)] font-medium text-[var(--text-primary)]">{bar.task.title}</span>
                          <span className={cn('truncate text-[length:var(--text-9)] tabular', bar.estimated ? 'text-[var(--text-tertiary)]' : 'text-[var(--warning)]')}>
                            {bar.task.timeEstimateMs != null && bar.task.timeEstimateMs > 0 ? formatTaskDuration(bar.task.timeEstimateMs) : t('todo.time.none')}
                          </span>
                        </div>
                        <div className="relative shrink-0" style={{ width: days.length * DAY_WIDTH }}>
                          <div className="pointer-events-none absolute inset-0 flex" aria-hidden="true">
                            {days.map((day) => (
                              <span key={day} className={cn('border-r border-[var(--border-subtle)]/60', day === today && 'bg-[var(--accent-soft)]/40')} style={{ width: DAY_WIDTH }} />
                            ))}
                          </div>
                          <div
                            className={cn('absolute top-1/2 -translate-y-1/2', drag?.task.id === bar.task.id && 'z-[var(--z-float)] opacity-90')}
                            style={{ left: first * DAY_WIDTH, width, height: BAR_HEIGHT }}
                            data-timeline-bar-wrap={bar.task.id}
                            data-timeline-start={shown.start}
                            data-timeline-end={shown.end}
                          >
                            <button
                              type="button"
                              data-timeline-bar={bar.task.id}
                              data-timeline-placeholder={bar.estimated ? undefined : ''}
                              aria-label={t('todo.a11y.open_task', { title: barLabel(bar) })}
                              title={barLabel(bar)}
                              {...pointerProps('move')}
                              onClick={() => {
                                if (suppressClick.current) { suppressClick.current = false; return }
                                openEditor({ id: bar.task.id })
                              }}
                              onKeyDown={(event) => {
                                const delta = keyboardDelta(event)
                                if (!event.shiftKey || delta === 0) return
                                event.preventDefault()
                                void commit(bar.task, bar, 'move', delta)
                              }}
                              className={cn(
                                'absolute inset-y-0 left-2 right-2 flex touch-none min-w-0 items-center overflow-hidden rounded-[var(--r-sm)] px-1.5 text-left text-[length:var(--text-10)] shadow-[var(--shadow-xs)] transition-opacity',
                                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                                bar.estimated
                                  ? 'text-[var(--text-primary)] hover:brightness-[0.97]'
                                  : 'border border-dashed border-[var(--border-strong)] bg-[var(--bg-sunken)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
                              )}
                              style={bar.estimated ? { backgroundColor: `color-mix(in oklab, ${color} 18%, var(--bg-surface))`, borderLeft: `2px solid ${color}` } : undefined}
                            >
                              <span className="truncate">{bar.estimated ? bar.task.title : t('todo.time.none')}</span>
                            </button>
                            {(['start', 'end'] as const).map((mode) => (
                              <button
                                key={mode}
                                type="button"
                                data-timeline-handle={mode}
                                aria-label={`${mode === 'start' ? t('todo.task.start_label') : t('todo.task.due_label')}: ${bar.task.title}`}
                                title={`${mode === 'start' ? t('todo.task.start_label') : t('todo.task.due_label')}: ${bar.task.title}`}
                                {...pointerProps(mode)}
                                onKeyDown={(event) => {
                                  const delta = keyboardDelta(event)
                                  if (delta === 0) return
                                  event.preventDefault()
                                  void commit(bar.task, bar, mode, delta)
                                }}
                                className={cn(
                                  'absolute inset-y-0 z-[1] flex w-4 touch-none items-center justify-center rounded-[var(--r-xs)] text-[var(--text-quaternary)]',
                                  'before:absolute before:inset-y-0 before:-inset-x-1 before:content-[\'\']',
                                  'hover:bg-[var(--bg-active)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                                  mode === 'start' ? '-left-2' : '-right-2',
                                )}
                              >
                                <span aria-hidden="true" className="h-3.5 w-px bg-current" />
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {unscheduled.length > 0 && (
                <section aria-label={t('project.view.unscheduled')} className="mt-3 overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                  <h3 className="border-b border-[var(--border-subtle)] px-3 py-2 text-[length:var(--text-11-5)] font-semibold text-[var(--text-secondary)]">
                    {t('project.view.unscheduled_count', { count: unscheduled.length })}
                  </h3>
                  <ul className="divide-y divide-[var(--border-subtle)]">
                    {unscheduled.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          onClick={() => openEditor({ id: task.id })}
                          className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-primary)]">{task.title}</span>
                          <span className="shrink-0 text-[length:var(--text-9)] text-[var(--text-quaternary)]">
                            {task.timeEstimateMs != null && task.timeEstimateMs > 0 ? formatTaskDuration(task.timeEstimateMs) : t('todo.time.none')}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </div>
  )
}

import { useEffect, useId, useRef, useState } from 'react'
import { Calendar as CalendarIcon, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, X } from 'lucide-react'
import { useClickOutside, useEscape } from './overlay'
import { cn } from '../lib/cn'
import { t, useLocale } from '../lib/i18n'
import { getVisibleViewport } from '../lib/viewport'
import { narrowWeekdayLabels, weekStartFor, type WeekStartDay } from '../lib/time'

interface DatePickerProps {
  /**
   * The property this picker edits. The visible text is only the date, so a
   * table row of dates would read as bare numbers; the name goes in beside it.
   */
  label: string
  value?: string
  placeholder?: string
  onChange: (dateStr: string) => void
  /**
   * When set, `value` and `onChange` carry `YYYY-MM-DDTHH:MM` and the popover grows a time row, so
   * a schedule field does not need the browser's own `datetime-local` control.
   */
  withTime?: boolean
}

const DEFAULT_TIME = '09:00'
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function splitValue(value: string | undefined, withTime: boolean): { date: string; time: string } {
  const head = value ?? ''
  if (!withTime) return { date: head.slice(0, 10), time: '' }
  const match = HHMM.exec(head.slice(11, 16))
  return { date: head.slice(0, 10), time: match ? head.slice(11, 16) : DEFAULT_TIME }
}

function joinValue(date: string, time: string, withTime: boolean): string {
  if (!date) return ''
  return withTime ? `${date}T${time}` : date
}

function displayValue(value: string | undefined, withTime: boolean, placeholder: string): string {
  if (!value) return placeholder
  const { date, time } = splitValue(value, withTime)
  return withTime ? `${date} ${time}` : value
}

interface CalendarDay {
  dateStr: string
  dayNum: number
  isCurrentMonth: boolean
}

function getTodayDateStr(): string {
  const now = new Date()
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function buildMonthCalendarDays(year: number, month: number, weekStart: number): CalendarDay[] {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  const firstDay = new Date(year, month, 1)
  const lastDay = new Date(year, month + 1, 0)
  const daysInMonth = lastDay.getDate()
  const days: CalendarDay[] = []

  let leadDays = (firstDay.getDay() - weekStart + 7) % 7
  const prevMonthLastDay = new Date(year, month, 0).getDate()
  for (let i = leadDays - 1; i >= 0; i--) {
    const d = prevMonthLastDay - i
    const m = month === 0 ? 12 : month
    const y = month === 0 ? year - 1 : year
    days.push({ dateStr: `${y}-${pad(m)}-${pad(d)}`, dayNum: d, isCurrentMonth: false })
  }

  for (let i = 1; i <= daysInMonth; i++) {
    days.push({ dateStr: `${year}-${pad(month + 1)}-${pad(i)}`, dayNum: i, isCurrentMonth: true })
  }

  const trailDays = (7 - (days.length % 7)) % 7
  for (let i = 1; i <= trailDays; i++) {
    const m = month + 2 > 12 ? 1 : month + 2
    const y = month + 2 > 12 ? year + 1 : year
    days.push({ dateStr: `${y}-${pad(m)}-${pad(i)}`, dayNum: i, isCurrentMonth: false })
  }
  return days
}

function MonthNavButtons({
  onPrevMonth,
  onNextMonth,
}: {
  onPrevMonth: () => void
  onNextMonth: () => void
}) {
  return (
    <div className='flex items-center gap-0.5'>
      <button
        type='button'
        onClick={onPrevMonth}
        aria-label={t('preview.kanban_prev_month')}
        className='flex size-6 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type='button'
        onClick={onNextMonth}
        aria-label={t('preview.kanban_next_month')}
        className='flex size-6 items-center justify-center rounded-[var(--r-xs)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function DatePickerHeader({
  year,
  month,
  locale,
  onPrevMonth,
  onNextMonth,
  onToday,
}: {
  year: number
  month: number
  locale: string
  onPrevMonth: () => void
  onNextMonth: () => void
  onToday: () => void
}) {
  const monthTitle = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(
    new Date(year, month, 1),
  )

  return (
    <div className='flex items-center justify-between border-b border-[var(--border-subtle)] pb-2'>
      <div className='flex items-center gap-1.5'>
        <span className='text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]'>
          {monthTitle}
        </span>
        <button
          type='button'
          onClick={onToday}
          className='rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[length:var(--text-10)] font-medium text-[var(--accent)] hover:opacity-85'
        >
          {t('preview.kanban_today')}
        </button>
      </div>
      <MonthNavButtons onPrevMonth={onPrevMonth} onNextMonth={onNextMonth} />
    </div>
  )
}

function DatePickerWeekRow({ weekStart, locale }: { weekStart: WeekStartDay; locale: string }) {
  const weekList = narrowWeekdayLabels(locale, weekStart)

  return (
    <div className='grid grid-cols-7 pt-2 text-center text-[length:var(--text-10)] font-semibold text-[var(--text-tertiary)]'>
      {weekList.map((w, idx) => (
        <span key={idx} className='py-0.5'>{w}</span>
      ))}
    </div>
  )
}

function getDayButtonClass(isSelected: boolean, isToday: boolean, isCurrentMonth: boolean): string {
  if (isSelected) {
    return 'bg-[var(--accent)] font-bold text-[var(--accent-contrast)] shadow-xs'
  }
  if (isToday) {
    return 'border border-[var(--accent)] font-bold text-[var(--accent)] hover:bg-[var(--bg-hover)]'
  }
  if (isCurrentMonth) {
    return 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
  }
  return 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]'
}

function DatePickerDaysGrid({
  days,
  selectedValue,
  todayStr,
  onSelectDate,
}: {
  days: CalendarDay[]
  selectedValue?: string
  todayStr: string
  onSelectDate: (dateStr: string) => void
}) {
  return (
    <div className='grid grid-cols-7 gap-y-1 pt-1'>
      {days.map((day) => {
        const isSelected = selectedValue === day.dateStr
        const isToday = todayStr === day.dateStr
        const btnClass = getDayButtonClass(isSelected, isToday, day.isCurrentMonth)

        return (
          <button
            key={day.dateStr}
            type='button'
            onClick={() => onSelectDate(day.dateStr)}
            className={`flex size-7 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-11)] transition-colors ${btnClass}`}
          >
            {day.dayNum}
          </button>
        )
      })}
    </div>
  )
}

function DatePickerFooter({
  todayStr,
  onClear,
  onToday,
}: {
  todayStr: string
  onClear: () => void
  onToday: (dateStr: string) => void
}) {
  return (
    <div className='flex items-center justify-between border-t border-[var(--border-subtle)] pt-2 mt-2'>
      <button
        type='button'
        onClick={onClear}
        className='text-[length:var(--text-11)] text-[var(--text-tertiary)] hover:text-[var(--danger)]'
      >
        {t('preview.kanban_clear_date')}
      </button>
      <button
        type='button'
        onClick={() => onToday(todayStr)}
        className='text-[length:var(--text-11)] font-semibold text-[var(--accent)] hover:opacity-85'
      >
        {t('preview.kanban_today')}
      </button>
    </div>
  )
}

function TimeSpinner({
  unit,
  value,
  limit,
  onChange,
}: {
  unit: string
  value: number
  limit: number
  onChange: (next: number) => void
}) {
  const step = (delta: number) => onChange((value + delta + limit + 1) % (limit + 1))

  return (
    <div
      role='group'
      aria-label={unit}
      className='flex flex-col items-center rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)]'
    >
      <button
        type='button'
        onClick={() => step(1)}
        aria-label={t('common.time_increase', { unit })}
        className='flex h-5 w-11 items-center justify-center rounded-t-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <ChevronUp size={12} />
      </button>
      <span className='text-[length:var(--text-12)] font-semibold tabular-nums text-[var(--text-primary)]'>
        {pad2(value)}
      </span>
      <button
        type='button'
        onClick={() => step(-1)}
        aria-label={t('common.time_decrease', { unit })}
        className='flex h-5 w-11 items-center justify-center rounded-b-[var(--r-sm)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      >
        <ChevronDown size={12} />
      </button>
    </div>
  )
}

function TimeRow({
  value,
  onChange,
  align,
}: {
  value: string
  onChange: (time: string) => void
  align: 'center' | 'between'
}) {
  const [hourText, minuteText] = (HHMM.test(value) ? value : DEFAULT_TIME).split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const commit = (nextHour: number, nextMinute: number) => onChange(`${pad2(nextHour)}:${pad2(nextMinute)}`)

  return (
    <div
      className={
        align === 'between'
          ? 'mt-2 flex items-center justify-between border-t border-[var(--border-subtle)] pt-2'
          : 'flex items-center gap-2'
      }
    >
      {align === 'between' && <Clock size={13} className='text-[var(--text-tertiary)]' />}
      <div className='flex items-center gap-1'>
        <TimeSpinner unit={t('common.time_hour')} value={hour} limit={23} onChange={(next) => commit(next, minute)} />
        <span className='text-[length:var(--text-12)] font-semibold text-[var(--text-tertiary)]'>:</span>
        <TimeSpinner unit={t('common.time_minute')} value={minute} limit={59} onChange={(next) => commit(hour, next)} />
      </div>
    </div>
  )
}

function useCalendarCursor(value?: string) {
  const parsed = value ? new Date(value) : new Date()
  const initialYear = Number.isNaN(parsed.getTime()) ? new Date().getFullYear() : parsed.getFullYear()
  const initialMonth = Number.isNaN(parsed.getTime()) ? new Date().getMonth() : parsed.getMonth()
  const [cursor, setCursor] = useState({ year: initialYear, month: initialMonth })

  const prevMonth = () => {
    setCursor((prev) =>
      prev.month === 0 ? { year: prev.year - 1, month: 11 } : { year: prev.year, month: prev.month - 1 },
    )
  }

  const nextMonth = () => {
    setCursor((prev) =>
      prev.month === 11 ? { year: prev.year + 1, month: 0 } : { year: prev.year, month: prev.month + 1 },
    )
  }

  const resetToday = () => {
    const now = new Date()
    setCursor({ year: now.getFullYear(), month: now.getMonth() })
  }

  return { cursor, prevMonth, nextMonth, resetToday }
}

interface Nudge {
  x: number
  up: boolean
}

/**
 * Where an in-flow panel has to be pushed to stay on screen.
 *
 * The calendar hangs `absolute left-0 top-full` off its field, which is right next to the edge when
 * the field sits in a narrow column — a two-up grid on a phone, a kanban property cell — and a 256px
 * panel then runs off the viewport. Shifting the panel is a plain function because the numbers, not
 * the renderer, are what worth pinning: the shift never takes the panel past the near margin, and the
 * flip only happens when there is genuinely more room above.
 */
export function nudgeFor({ anchor, panel, viewport, gap = 4, margin = 8 }: {
  anchor: { left: number, bottom: number, top: number }
  panel: { width: number, height: number }
  viewport: { left: number, right: number, top: number, bottom: number }
  gap?: number
  margin?: number
}): Nudge {
  const preferred = anchor.left + panel.width
  let x = preferred > viewport.right - margin ? viewport.right - margin - panel.width - anchor.left : 0
  x = Math.max(x, viewport.left + margin - anchor.left)
  const belowFits = anchor.bottom + gap + panel.height <= viewport.bottom - margin
  const aboveFits = anchor.top - gap - panel.height >= viewport.top + margin
  return { x, up: !belowFits && aboveFits }
}

/**
 * How far a panel may reach sideways before its own scroll container would cut it off.
 *
 * A field inside a modal body that scrolls gets a panel that widens that body by a few pixels, and the
 * reader sees a horizontal scrollbar appear under the form. The vertical axis is left to the viewport
 * because a scroll container is expected to scroll there; sideways it is only ever an accident.
 */
function horizontalClip(start: HTMLElement | null): { left: number, right: number } | null {
  let clip: { left: number, right: number } | null = null
  for (let node = start?.parentElement ?? null; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (!/auto|scroll|hidden/.test(`${style.overflowX}${style.overflowY}`)) continue
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0) continue
    clip = clip
      ? { left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right) }
      : { left: rect.left, right: rect.right }
  }
  return clip
}

function useNudge(
  containerRef: React.RefObject<HTMLDivElement | null>,
  popoverRef: React.RefObject<HTMLDivElement | null>,
  open: boolean,
): Nudge {
  const [nudge, setNudge] = useState<Nudge>({ x: 0, up: false })

  useEffect(() => {
    if (!open) return
    const container = containerRef.current
    const popover = popoverRef.current
    if (!container || !popover) return
    const rect = container.getBoundingClientRect()
    const viewport = getVisibleViewport()
    const clip = horizontalClip(container)
    const next = nudgeFor({
      anchor: { left: rect.left, bottom: rect.bottom, top: rect.top },
      panel: { width: popover.offsetWidth, height: popover.offsetHeight },
      viewport: clip
        ? { ...viewport, left: Math.max(viewport.left, clip.left), right: Math.min(viewport.right, clip.right) }
        : viewport,
    })
    // Comparing by value keeps a stable result from re-rendering, which would re-measure forever.
    setNudge((prev) => (prev.x === next.x && prev.up === next.up ? prev : next))
  }, [open, containerRef, popoverRef])

  return nudge
}

function DatePickerPopover({
  panelId,
  value,
  withTime,
  containerRef,
  onClose,
  onChange,
}: {
  panelId: string
  value?: string
  withTime: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onChange: (dateStr: string) => void
}) {
  const locale = useLocale()
  const weekStart = weekStartFor(locale)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { cursor, prevMonth, nextMonth, resetToday } = useCalendarCursor(value)
  const todayStr = getTodayDateStr()
  const [time, setTime] = useState(() => splitValue(value, withTime).time)
  const nudge = useNudge(containerRef, popoverRef, true)

  useClickOutside([popoverRef, containerRef], true, onClose)
  useEscape(true, onClose)
  const days = buildMonthCalendarDays(cursor.year, cursor.month, weekStart)
  const selectedDate = splitValue(value, withTime).date

  const pickDate = (d: string) => {
    onChange(joinValue(d, time, withTime))
    if (!withTime) onClose()
  }

  const pickTime = (next: string) => {
    setTime(next)
    onChange(joinValue(selectedDate || todayStr, next, withTime))
  }

  return (
    <div
      id={panelId}
      ref={popoverRef}
      role='dialog'
      aria-label={t('preview.kanban_select_date')}
      style={{ ...(nudge.x ? { transform: `translateX(${nudge.x}px)` } : {}) }}
      className={cn(
        'absolute left-0 z-[var(--z-popover)] w-64 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]',
        nudge.up ? 'bottom-full mb-1' : 'top-full mt-1',
      )}
    >
      <DatePickerHeader
        year={cursor.year}
        month={cursor.month}
        locale={locale}
        onPrevMonth={prevMonth}
        onNextMonth={nextMonth}
        onToday={resetToday}
      />
      <DatePickerWeekRow weekStart={weekStart} locale={locale} />
      <DatePickerDaysGrid
        days={days}
        selectedValue={selectedDate}
        todayStr={todayStr}
        onSelectDate={pickDate}
      />
      {withTime && <TimeRow value={time} onChange={pickTime} align="between" />}
      <DatePickerFooter
        todayStr={todayStr}
        onClear={() => {
          onChange('')
          onClose()
        }}
        onToday={pickDate}
      />
    </div>
  )
}

export function DatePicker({
  label,
  value,
  placeholder,
  onChange,
  withTime = false,
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const shown = displayValue(value, withTime, placeholder || t('preview.kanban_select_date'))

  return (
    <div
      ref={containerRef}
      className='relative flex h-8 w-full items-center justify-between rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 transition-colors hover:border-[var(--border-strong)]'
    >
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex flex-1 items-center gap-1.5 truncate text-left text-[length:var(--text-12)] text-[var(--text-primary)]'
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <span className='sr-only'>{label}</span>
        <CalendarIcon size={13} className='shrink-0 text-[var(--text-tertiary)]' />
        <span className={value ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-quaternary)]'}>
          {shown}
        </span>
      </button>

      {value && (
        <button
          type='button'
          onClick={() => onChange('')}
          className='p-0.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] rounded-[var(--r-xs)] transition-colors'
          aria-label={t('preview.kanban_clear_date')}
        >
          <X size={12} />
        </button>
      )}

      {open && (
        <DatePickerPopover
          panelId={panelId}
          value={value}
          withTime={withTime}
          containerRef={containerRef}
          onClose={() => setOpen(false)}
          onChange={onChange}
        />
      )}
    </div>
  )
}

export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (time: string) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useClickOutside([popoverRef, containerRef], open, () => setOpen(false))
  useEscape(open, () => setOpen(false))
  const nudge = useNudge(containerRef, popoverRef, open)

  return (
    <div
      ref={containerRef}
      className='relative flex h-8 w-full items-center justify-between rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2.5 transition-colors hover:border-[var(--border-strong)]'
    >
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex flex-1 items-center gap-1.5 text-left text-[length:var(--text-12)] text-[var(--text-primary)]'
        aria-haspopup='dialog'
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
      >
        <span className='sr-only'>{label}</span>
        <Clock size={13} className='shrink-0 text-[var(--text-tertiary)]' />
        <span className='font-medium tabular-nums'>{HHMM.test(value) ? value : DEFAULT_TIME}</span>
      </button>

      {open && (
        <div
          id={panelId}
          ref={popoverRef}
          role='dialog'
          aria-label={t('common.time_select')}
          style={{ ...(nudge.x ? { transform: `translateX(${nudge.x}px)` } : {}) }}
          className={cn(
            'absolute left-0 z-[var(--z-popover)] w-64 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]',
            nudge.up ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <TimeRow value={HHMM.test(value) ? value : DEFAULT_TIME} onChange={onChange} align="center" />
        </div>
      )}
    </div>
  )
}

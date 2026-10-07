import { useId, useRef, useState } from 'react'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useClickOutside, useEscape } from '../../../../components/overlay'
import { t, useLocale } from '../../../i18n'
import { narrowWeekdayLabels, weekStartFor, type WeekStartDay } from '../../../time'

interface KanbanDatePickerProps {
  /**
   * The property this picker edits. The visible text is only the date, so a
   * table row of dates would read as bare numbers; the name goes in beside it.
   */
  propertyName: string
  value?: string
  placeholder?: string
  onChange: (dateStr: string) => void
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

function DatePickerPopover({
  panelId,
  value,
  containerRef,
  onClose,
  onChange,
}: {
  panelId: string
  value?: string
  containerRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onChange: (dateStr: string) => void
}) {
  const locale = useLocale()
  const weekStart = weekStartFor(locale)
  const popoverRef = useRef<HTMLDivElement>(null)
  const { cursor, prevMonth, nextMonth, resetToday } = useCalendarCursor(value)
  const todayStr = getTodayDateStr()

  useClickOutside([popoverRef, containerRef], true, onClose)
  useEscape(true, onClose)
  const days = buildMonthCalendarDays(cursor.year, cursor.month, weekStart)

  const handleSelect = (d: string) => {
    onChange(d)
    onClose()
  }

  return (
    <div
      id={panelId}
      ref={popoverRef}
      role='dialog'
      aria-label={t('preview.kanban_select_date')}
      className='absolute left-0 top-full z-[var(--z-popover)] mt-1 w-64 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-3 shadow-[var(--shadow-pop)]'
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
        selectedValue={value}
        todayStr={todayStr}
        onSelectDate={handleSelect}
      />
      <DatePickerFooter
        todayStr={todayStr}
        onClear={() => handleSelect('')}
        onToday={(today) => handleSelect(today)}
      />
    </div>
  )
}

export function KanbanDatePicker({
  propertyName,
  value,
  placeholder,
  onChange,
}: KanbanDatePickerProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

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
        <span className='sr-only'>{propertyName}</span>
        <CalendarIcon size={13} className='shrink-0 text-[var(--text-tertiary)]' />
        <span className={value ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-quaternary)]'}>
          {value || placeholder || t('preview.kanban_select_date')}
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
          containerRef={containerRef}
          onClose={() => setOpen(false)}
          onChange={onChange}
        />
      )}
    </div>
  )
}

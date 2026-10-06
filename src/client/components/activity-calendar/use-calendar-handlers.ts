import { useEffect } from 'react'
import type { DateRangeFilter } from '@shared/types'
import { dateKey } from '../../lib/time'
import { monthRangeToKeys } from './range'
import type { WeekCell } from './strip'
import type { ActivityCalendarProps } from './props'
import type { CalendarBase, CalendarState, FlashState, LatestState, MonthState, StripState } from './types'


function normalizeRange(a: string, b: string): DateRangeFilter {
  return a <= b ? { start: a, end: b } : { start: b, end: a }
}

function monthMoveIndex(key: string, index: number, length: number): number {
  switch (key) {
    case 'ArrowLeft': return index - 1
    case 'ArrowRight': return index + 1
    case 'ArrowUp': return index - 7
    case 'ArrowDown': return index + 7
    case 'Home': return 0
    case 'End': return length - 1
    default: return index
  }
}

function yearMoveIndex(key: string, index: number, columns: number): number {
  switch (key) {
    case 'ArrowUp': return index - columns
    case 'ArrowDown': return index + columns
    case 'Home': return 0
    case 'End': return 11
    default: return index
  }
}

export interface NavHandlers {
  shiftMonth: (delta: number) => void
  shiftYear: (delta: number) => void
  jumpToCurrentMonth: () => void
  jumpToCurrentYear: () => void
  handleWeekdayClick: (month: number, column: number) => void
  focusWeekday: (month: number, column: number, scope: Element) => void
}

export function useCalendarNav(props: ActivityCalendarProps, base: CalendarBase, flash: FlashState): NavHandlers {
  const weekStart = props.weekStart ?? 1
  const shiftMonth = (delta: number) => {
    const month = props.cursor.month + delta
    props.onCursorChange({ year: props.cursor.year + Math.floor(month / 12), month: ((month % 12) + 12) % 12 })
  }
  const shiftYear = (delta: number) => props.onCursorChange({ year: props.cursor.year + delta, month: props.cursor.month })
  const jumpToCurrentMonth = () => props.onCursorChange({ year: base.now.getFullYear(), month: base.now.getMonth() })
  const jumpToCurrentYear = () => props.onCursorChange({ year: base.now.getFullYear(), month: props.cursor.month })
  const handleWeekdayClick = (month: number, column: number) => {
    flash.flash()
    const first = new Date(props.cursor.year, month, 1)
    const offset = (first.getDay() - weekStart + 7) % 7
    const day = 1 + ((column - offset + 7) % 7)
    const date = new Date(props.cursor.year, month, day)
    const start = new Date(date)
    start.setDate(start.getDate() - ((start.getDay() - weekStart + 7) % 7))
    const end = new Date(start)
    end.setDate(end.getDate() + 6)
    props.onCursorChange({ year: props.cursor.year, month })
    props.onViewChange('month')
    props.onRangeSelect(dateKey(start), dateKey(end))
  }
  const focusWeekday = (month: number, column: number, scope: Element) => {
    scope.querySelector<HTMLButtonElement>(`[data-month-card="${month}"] [data-weekday="${column}"]`)?.focus()
  }
  return { shiftMonth, shiftYear, jumpToCurrentMonth, jumpToCurrentYear, handleWeekdayClick, focusWeekday }
}

export interface MonthGridHandlers {
  handleGridKeyDown: React.KeyboardEventHandler
  handleGridMouseDown: React.MouseEventHandler
  handleGridMouseEnter: React.MouseEventHandler
}

export function useMonthGridHandlers(props: ActivityCalendarProps, state: CalendarState, month: MonthState): MonthGridHandlers {
  const handleGridKeyDown = (event: React.KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return
    event.preventDefault()
    const anchor = event.shiftKey ? month.focusKey : null
    let index = month.inMonthKeys.indexOf(month.focusKey)
    if (index < 0)
      index = 0
    index = Math.max(0, Math.min(month.inMonthKeys.length - 1, monthMoveIndex(event.key, index, month.inMonthKeys.length)))
    const targetKey = month.inMonthKeys[index]
    if (!targetKey)
      return
    state.setFocusedKey(targetKey)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-day-key="${targetKey}"]`)?.focus()
    if (anchor !== null) {
      const range = normalizeRange(anchor, targetKey)
      props.onRangeSelect(range.start, range.end)
    }
  }
  const handleGridMouseDown = (event: React.MouseEvent) => {
    const key = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day-key]')?.dataset.dayKey ?? null
    if (key === null)
      return
    state.dragStartKey.current = key
    state.dragHoverKey.current = key
    state.setDragRange(null)
  }
  const handleGridMouseEnter = (event: React.MouseEvent) => {
    if (state.dragStartKey.current === null)
      return
    const key = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-day-key]')?.dataset.dayKey ?? null
    if (key === null)
      return
    state.dragHoverKey.current = key
    state.setDragRange(normalizeRange(state.dragStartKey.current, key))
  }
  return { handleGridKeyDown, handleGridMouseDown, handleGridMouseEnter }
}

export function useRootKeyHandler(props: ActivityCalendarProps, state: CalendarState): React.KeyboardEventHandler {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape')
      return
    if (props.view === 'year' && state.yearRangeAnchor !== null) {
      state.setYearRangeAnchor(null)
      state.setYearRangeHover(null)
      return
    }
    if (state.expandedDay !== null) {
      state.setExpandedDay(null)
      return
    }
    if (state.isExpandedWeekNotes) {
      state.setIsExpandedWeekNotes(false)
      return
    }
    if (state.expandedWeek !== null)
      state.setExpandedWeek(null)
  }
}

export interface YearGridHandlers {
  handleYearGridKeyDown: React.KeyboardEventHandler
  handleMonthClick: (event: React.MouseEvent, month: number) => void
}

export function useYearGridHandlers(props: ActivityCalendarProps, state: CalendarState, base: CalendarBase, nav: NavHandlers, flash: FlashState): YearGridHandlers {
  const handleYearGridKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'PageUp') {
      event.preventDefault()
      nav.shiftYear(-1)
      return
    }
    if (event.key === 'PageDown') {
      event.preventDefault()
      nav.shiftYear(1)
      return
    }
    const target = event.target as HTMLElement
    const weekdayButton = target.closest<HTMLButtonElement>('[data-weekday]')
    const card = target.closest<HTMLElement>('[data-month-card]')
    const cardMonth = card ? Number(card.getAttribute('data-month-card')) : -1
    if (weekdayButton && cardMonth >= 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) {
      event.preventDefault()
      const column = Number(weekdayButton.getAttribute('data-weekday'))
      if (event.key === 'ArrowLeft')
        nav.focusWeekday(cardMonth, Math.max(0, column - 1), event.currentTarget)
      else if (event.key === 'ArrowRight')
        nav.focusWeekday(cardMonth, Math.min(6, column + 1), event.currentTarget)
      else
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-month="${cardMonth}"]`)?.focus()
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
      return
    event.preventDefault()
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && cardMonth >= 0) {
      nav.focusWeekday(cardMonth, 0, event.currentTarget)
      return
    }
    let index = base.focusMonth
    index = Math.max(0, Math.min(11, yearMoveIndex(event.key, index, base.yearColumns)))
    state.setFocusedMonth(index)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-month="${index}"]`)?.focus()
  }
  return { handleYearGridKeyDown, handleMonthClick: useYearMonthClick(props, state, flash) }
}

function useYearMonthClick(props: ActivityCalendarProps, state: CalendarState, flash: FlashState) {
  return (event: React.MouseEvent, month: number) => {
    state.setFocusedMonth(month)
    if (event.detail === 0) {
      props.onCursorChange({ year: props.cursor.year, month })
      props.onViewChange('month')
      flash.flash()
      return
    }
    if (state.yearRangeAnchor === null) {
      state.setYearRangeAnchor({ year: props.cursor.year, month })
      state.setYearRangeHover(month)
      return
    }
    const range = monthRangeToKeys(state.yearRangeAnchor.year, state.yearRangeAnchor.month, month)
    state.setYearRangeAnchor(null)
    state.setYearRangeHover(null)
    props.onRangeSelect(range.start, range.end)
  }
}

export interface StripHandlers {
  toggleWeek: (index: number) => void
  isWeekRangeActive: (week: WeekCell[]) => boolean
  handleGapDayClick: (key: string) => void
  activateDay: (key: string, diaryId: string | null) => void
  handleStripWeekClick: (event: React.MouseEvent, weekIndex: number) => void
  toggleDay: (key: string) => void
  toggleWeekNotes: () => void
  jumpToDay: (key: string) => void
}

export function useStripHandlers(props: ActivityCalendarProps, state: CalendarState, strip: StripState, latest: LatestState, flash: FlashState): StripHandlers {
  const toggleWeek = (index: number) => {
    state.setExpandedWeek((current) => current === index ? null : index)
    state.setExpandedDay(null)
    state.setIsExpandedWeekNotes(false)
  }
  const isWeekRangeActive = (week: WeekCell[]) => props.selectedRange != null && week[0]?.key === props.selectedRange.start && week[6]?.key === props.selectedRange.end
  const handleGapDayClick = (key: string) => {
    flash.flash()
    props.onGapDayClick(key)
  }
  const activateDay = (key: string, diaryId: string | null) => {
    if (latest.isLatestOutside(key) && latest.latestEditOutside !== null)
      handleGapDayClick(key)
    else
      props.onDayClick(key, diaryId)
  }
  const handleStripWeekClick = (event: React.MouseEvent, weekIndex: number) => {
    const week = strip.stripWeeks[weekIndex]
    const first = week?.[0]?.key
    const last = week?.[6]?.key
    if (first && last)
      props.onRangeSelect(first, last)
    if (!event.shiftKey)
      toggleWeek(weekIndex)
    flash.flash()
  }
  const toggleDay = (key: string) => state.setExpandedDay((current) => (current === key ? null : key))
  const toggleWeekNotes = () => state.setIsExpandedWeekNotes((open) => !open)
  const jumpToDay = (key: string) => {
    const [year, month] = key.split('-').map(Number)
    state.setFocusedKey(key)
    props.onCursorChange({ year, month: month - 1 })
    props.onViewChange('month')
    props.onDaySelect(key)
  }
  return { toggleWeek, isWeekRangeActive, handleGapDayClick, activateDay, handleStripWeekClick, toggleDay, toggleWeekNotes, jumpToDay }
}

export function useRangeDragFinish(props: ActivityCalendarProps, state: CalendarState): void {
  useEffect(() => {
    const onWindowMouseUp = () => {
      if (state.dragStartKey.current === null)
        return
      const anchor = state.dragStartKey.current
      const hover = state.dragHoverKey.current
      state.dragStartKey.current = null
      state.dragHoverKey.current = null
      state.setDragRange(null)
      if (hover !== null && hover !== anchor) {
        const range = normalizeRange(anchor, hover)
        props.onRangeSelect(range.start, range.end)
      }
    }
    window.addEventListener('mouseup', onWindowMouseUp)
    return () => window.removeEventListener('mouseup', onWindowMouseUp)
  }, [props.onRangeSelect])
}
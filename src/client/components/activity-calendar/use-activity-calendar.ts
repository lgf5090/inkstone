import { useEffect, useMemo, useRef, useState } from 'react'
import type { DateRangeFilter } from '@shared/types'
import { t } from '../../lib/i18n'
import { dateKey, narrowWeekdayLabels, type WeekStartDay } from '../../lib/time'
import { buildStripWeeks, buildYearHeatMeta, yearHeatLevel, type WeekCell } from './strip'
import { latestEditOutsideWindow } from '../../features/list/gap-indicator'
import { YEAR_GRID_COLUMNS, buildMonthGridCells, yearGridColumns, type YearGridColumns } from '../calendar-grids'
import type { ActivityCalendarProps } from './props'
import type { CalendarState, FlashState, CalendarBase, MonthState, StripState, LatestState } from './types'
import { useCalendarNav, useMonthGridHandlers, useRangeDragFinish, useRootKeyHandler, useStripHandlers, useYearGridHandlers, type MonthGridHandlers, type NavHandlers, type StripHandlers, type YearGridHandlers } from './use-calendar-handlers'

export type { CalendarState, FlashState, CalendarBase, MonthState, StripState, LatestState } from './types'

function useCalendarState(measureColumns: boolean): CalendarState {
  const [expandedWeek, setExpandedWeek] = useState<number | null>(null)
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const [isExpandedWeekNotes, setIsExpandedWeekNotes] = useState(false)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const [focusedMonth, setFocusedMonth] = useState<number | null>(null)
  const [dragRange, setDragRange] = useState<DateRangeFilter | null>(null)
  const [yearRangeAnchor, setYearRangeAnchor] = useState<{ year: number; month: number } | null>(null)
  const [yearRangeHover, setYearRangeHover] = useState<number | null>(null)
  const lastExpandedWeek = useRef<number | null>(null)
  const lastExpandedDay = useRef<string | null>(null)
  const dragStartKey = useRef<string | null>(null)
  const dragHoverKey = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  // The width is kept as the answer it produces, never as a number: the navigation panel
  // animates its width, so a raw `contentRect.width` reached this component as around twenty
  // distinct fractions per deliberate change and each one re-rendered the whole heat grid.
  const [measuredColumns, setMeasuredColumns] = useState<YearGridColumns | null>(null)
  useEffect(() => {
    if (!measureColumns)
      return
    const el = rootRef.current
    if (!el)
      return
    setMeasuredColumns(yearGridColumns(el.getBoundingClientRect().width))
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries)
        setMeasuredColumns(yearGridColumns(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [measureColumns])
  return { expandedWeek, setExpandedWeek, expandedDay, setExpandedDay, isExpandedWeekNotes, setIsExpandedWeekNotes, focusedKey, setFocusedKey, focusedMonth, setFocusedMonth, dragRange, setDragRange, yearRangeAnchor, setYearRangeAnchor, yearRangeHover, setYearRangeHover, lastExpandedWeek, lastExpandedDay, dragStartKey, dragHoverKey, rootRef, measuredColumns }
}

function useCalendarFlash(jumpFlash: number, view: 'month' | 'weeks' | 'year'): FlashState {
  const monthFlashRef = useRef<HTMLDivElement | null>(null)
  const weekFlashRef = useRef<HTMLDivElement | null>(null)
  const [internalFlash, setInternalFlash] = useState(0)
  const flash = () => setInternalFlash((n) => n + 1)
  const flashNonce = jumpFlash + internalFlash
  useEffect(() => {
    // Marks an external month jump (settings preview click) or an internal jump (week click, gap-cell follow, endpoint locate) with the same fade-in + receding accent ring.
    if (flashNonce <= 0)
      return
    const el = view === 'month' ? monthFlashRef.current : view === 'weeks' ? weekFlashRef.current : null
    if (!el || typeof el.animate !== 'function')
      return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      return
    const animation = el.animate([
      { opacity: 0.25, boxShadow: '0 0 0 2px var(--accent)' },
      { opacity: 1, boxShadow: '0 0 0 9px rgba(0, 0, 0, 0)' },
    ], { duration: 1100, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' })
    return () => animation.cancel()
  }, [flashNonce, view])
  return { monthFlashRef, weekFlashRef, flash, flashNonce }
}

function useCalendarBase(props: ActivityCalendarProps, state: CalendarState): CalendarBase {
  const now = useMemo(() => props.today ?? new Date(), [props.today])
  const todayKey = dateKey(now)
  const isCurrentMonth = props.cursor.year === now.getFullYear() && props.cursor.month === now.getMonth()
  const isCurrentYear = props.cursor.year === now.getFullYear()
  const weekdayLabels = useMemo(() => narrowWeekdayLabels(props.locale, props.weekStart ?? 1), [props.locale, props.weekStart])
  const gridTitle = useMemo(() => new Intl.DateTimeFormat(props.locale, {
    year: 'numeric',
    month: 'long',
  }).format(new Date(props.cursor.year, props.cursor.month, 1)), [props.cursor, props.locale])
  const monthLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(props.locale, { month: 'short' })
    return Array.from({ length: 12 }, (_, month) => formatter.format(new Date(props.cursor.year, month, 1)))
  }, [props.cursor.year, props.locale])
  const yearColumns: YearGridColumns = props.columnsPreference !== 'auto' ? (props.columnsPreference === '4' ? 4 : 3) : (state.measuredColumns ?? YEAR_GRID_COLUMNS)
  const focusMonth = state.focusedMonth !== null && state.focusedMonth >= 0 && state.focusedMonth < 12
    ? state.focusedMonth
    : (isCurrentYear ? now.getMonth() : 0)
  return { now, todayKey, isCurrentMonth, isCurrentYear, weekdayLabels, gridTitle, monthLabels, yearColumns, focusMonth }
}

function useCalendarMonth(props: ActivityCalendarProps, state: CalendarState, base: CalendarBase): MonthState {
  const monthCells = useMemo(() => buildMonthGridCells(props.cursor.year, props.cursor.month, props.weekStart ?? 1, base.todayKey), [props.cursor, base.todayKey, props.weekStart])
  const inMonthKeys = useMemo(() => monthCells.filter((cell) => cell.inMonth).map((cell) => cell.key), [monthCells])
  const focusKey = state.focusedKey !== null && inMonthKeys.includes(state.focusedKey)
    ? state.focusedKey
    : (monthCells.find((cell) => cell.today)?.key ?? inMonthKeys[0] ?? null)
  const cellMeta = useMemo(() => {
    let max = 0
    const byKey = new Map<string, number>()
    for (const cell of monthCells) {
      if (!cell.inMonth)
        continue
      const count = props.counts.get(cell.key) ?? 0
      byKey.set(cell.key, count)
      if (count > max)
        max = count
    }
    return { byKey, max }
  }, [props.counts, monthCells])
  const effectiveRange = state.dragRange ?? props.selectedRange
  const inRange = (key: string) => effectiveRange != null && key >= effectiveRange.start && key <= effectiveRange.end
  return { inMonthKeys, focusKey, cellMeta, inRange }
}


interface YearState {
  yearMeta: { totals: number[]; yearMax: number }
  yearLevel: (key: string) => number
}

function useCalendarYear(props: ActivityCalendarProps, state: CalendarState): YearState {
  const yearMeta = useMemo(() => buildYearHeatMeta(props.counts, props.cursor.year), [props.counts, props.cursor.year])
  const yearLevel = (key: string) => yearHeatLevel(props.counts, yearMeta.yearMax, key)
  useEffect(() => {
    state.setYearRangeAnchor(null)
    state.setYearRangeHover(null)
  }, [props.view, props.cursor.year])
  return { yearMeta, yearLevel }
}

function useCalendarStrip(props: ActivityCalendarProps, base: CalendarBase, state: CalendarState): StripState {
  if (state.expandedWeek !== null)
    state.lastExpandedWeek.current = state.expandedWeek
  if (state.expandedDay !== null)
    state.lastExpandedDay.current = state.expandedDay
  const shownWeek = state.expandedWeek ?? state.lastExpandedWeek.current
  const shownDay = state.expandedDay ?? state.lastExpandedDay.current
  const stripWeeks = useMemo(() => buildStripWeeks(props.counts, { range: props.range, weekStart: props.weekStart, now: base.now, todayKey: base.todayKey, selectedRange: props.selectedRange, getDiaryId: props.getDiaryId, notesByDay: props.notesByDay }), [props.counts, props.getDiaryId, props.notesByDay, base.now, props.range, props.selectedRange, base.todayKey, props.weekStart])
  const weekCells = shownWeek !== null ? stripWeeks[shownWeek] : undefined
  const weekCellsTotal = weekCells?.reduce((sum, cell) => sum + cell.notes.length, 0) ?? 0
  return { stripWeeks, weekCells, weekCellsTotal, shownWeek, shownDay }
}

function useCalendarLatest(props: ActivityCalendarProps): LatestState {
  const latestEditOutside = latestEditOutsideWindow(props.selectedRange, props.latestEditKey)
  const latestEditOutsideKey = latestEditOutside?.key ?? null
  const latestOutsideDays = latestEditOutside?.days ?? null
  const isLatestOutside = (key: string) => latestEditOutsideKey === key
  const gapAhead = latestEditOutside?.ahead ?? false
  const dayLabel = (key: string) => t('sidebar.calendar_day_tooltip_value0', { value0: key, value1: props.counts.get(key) ?? 0 })
  const flaggedLabel = (key: string) => isLatestOutside(key)
    ? `${dayLabel(key)} · ${t('sidebar.calendar_outside_window_value0', { value0: latestOutsideDays ?? 0 })}`
    : dayLabel(key)
  const gapLabel = (key: string) => isLatestOutside(key)
    ? `${flaggedLabel(key)} · ${t('sidebar.calendar_gap_click_follow')}`
    : flaggedLabel(key)
  return { latestEditOutside, latestEditOutsideKey, latestOutsideDays, isLatestOutside, gapAhead, dayLabel, flaggedLabel, gapLabel }
}

export interface MonthViewBundle {
  cursor: { year: number; month: number }
  weekStart: WeekStartDay
  todayKey: string
  weekdayLabels: string[]
  gridTitle: string
  cellMeta: { byKey: Map<string, number>; max: number }
  focusKey: string
  inRange: (key: string) => boolean
  gapLabel: (key: string) => string
  isLatestOutside: (key: string) => boolean
  gapAhead: boolean
  latestOutsideDays: number | null
  latestOutsideKey: string | null
  getDiaryId: ((key: string) => string | null) | undefined
  onGapDayClick: (key: string) => void
  onKeyDown: React.KeyboardEventHandler
  onMouseDown: React.MouseEventHandler
  onMouseEnter: React.MouseEventHandler
  onActivateDay: (key: string, diaryId: string | null) => void
  onFocusDay: (key: string) => void
  flashRef: React.RefObject<HTMLDivElement | null>
}

function buildMonthView(props: ActivityCalendarProps, state: CalendarState, base: CalendarBase, month: MonthState, latest: LatestState, monthHandlers: MonthGridHandlers, stripHandlers: StripHandlers, flash: FlashState): MonthViewBundle {
  return {
    cursor: props.cursor, weekStart: props.weekStart ?? 1,
    todayKey: base.todayKey, weekdayLabels: base.weekdayLabels, gridTitle: base.gridTitle,
    cellMeta: month.cellMeta, focusKey: month.focusKey,
    inRange: month.inRange, gapLabel: latest.gapLabel, isLatestOutside: latest.isLatestOutside,
    gapAhead: latest.gapAhead, latestOutsideDays: latest.latestOutsideDays,
    latestOutsideKey: latest.latestEditOutsideKey, getDiaryId: props.getDiaryId,
    onGapDayClick: stripHandlers.handleGapDayClick, onKeyDown: monthHandlers.handleGridKeyDown,
    onMouseDown: monthHandlers.handleGridMouseDown, onMouseEnter: monthHandlers.handleGridMouseEnter,
    onActivateDay: stripHandlers.activateDay, onFocusDay: state.setFocusedKey,
    flashRef: flash.monthFlashRef,
  }
}

export interface YearViewBundle {
  cursor: { year: number; month: number }
  weekStart: WeekStartDay
  todayKey: string
  columns: YearGridColumns
  weekdayLabels: string[]
  monthLabels: string[]
  yearMeta: { totals: number[]; yearMax: number }
  yearLevel: (key: string) => number
  focusMonth: number
  yearRangeAnchor: { year: number; month: number } | null
  yearRangeHover: number | null
  onKeyDown: React.KeyboardEventHandler
  onMonthClick: (event: React.MouseEvent, month: number) => void
  onWeekdayClick: (month: number, column: number) => void
  onAnchorHover: (month: number) => void
}

function buildYearView(props: ActivityCalendarProps, state: CalendarState, base: CalendarBase, year: YearState, nav: NavHandlers, yearHandlers: YearGridHandlers): YearViewBundle {
  return {
    cursor: props.cursor, weekStart: props.weekStart ?? 1, todayKey: base.todayKey,
    columns: base.yearColumns, weekdayLabels: base.weekdayLabels, monthLabels: base.monthLabels,
    yearMeta: year.yearMeta, yearLevel: year.yearLevel, focusMonth: base.focusMonth,
    yearRangeAnchor: state.yearRangeAnchor, yearRangeHover: state.yearRangeHover,
    onKeyDown: yearHandlers.handleYearGridKeyDown, onMonthClick: yearHandlers.handleMonthClick,
    onWeekdayClick: nav.handleWeekdayClick, onAnchorHover: state.setYearRangeHover,
  }
}

export interface WeekViewBundle {
  stripWeeks: WeekCell[][]
  expandedWeek: number | null
  shownWeek: number | null
  expandedDay: string | null
  shownDay: string | null
  isExpandedWeekNotes: boolean
  weekCells: WeekCell[] | undefined
  weekCellsTotal: number
  weekdayLabels: string[]
  flashRef: React.RefObject<HTMLDivElement | null>
  onStripWeekClick: (event: React.MouseEvent, weekIndex: number) => void
  onToggleDay: (key: string) => void
  onToggleWeekNotes: () => void
  onActivateDay: (key: string, diaryId: string | null) => void
  onNoteClick: (noteId: string) => void
  onJumpToDay: (key: string) => void
  isWeekRangeActive: (week: WeekCell[]) => boolean
  isLatestOutside: (key: string) => boolean
  gapLabel: (key: string) => string
  flaggedLabel: (key: string) => string
}

function buildWeekView(props: ActivityCalendarProps, state: CalendarState, base: CalendarBase, strip: StripState, latest: LatestState, stripHandlers: StripHandlers, flash: FlashState): WeekViewBundle {
  return {
    stripWeeks: strip.stripWeeks, expandedWeek: state.expandedWeek, shownWeek: strip.shownWeek,
    expandedDay: state.expandedDay, shownDay: strip.shownDay,
    isExpandedWeekNotes: state.isExpandedWeekNotes, weekCells: strip.weekCells,
    weekCellsTotal: strip.weekCellsTotal, weekdayLabels: base.weekdayLabels,
    flashRef: flash.weekFlashRef, onStripWeekClick: stripHandlers.handleStripWeekClick,
    onToggleDay: stripHandlers.toggleDay, onToggleWeekNotes: stripHandlers.toggleWeekNotes,
    onActivateDay: stripHandlers.activateDay, onNoteClick: props.onNoteClick,
    onJumpToDay: stripHandlers.jumpToDay, isWeekRangeActive: stripHandlers.isWeekRangeActive,
    isLatestOutside: latest.isLatestOutside, gapLabel: latest.gapLabel, flaggedLabel: latest.flaggedLabel,
  }
}


interface CalendarHook {
  view: 'month' | 'weeks' | 'year'
  onViewChange: (view: 'month' | 'weeks' | 'year') => void
  rootRef: React.RefObject<HTMLDivElement | null>
  onRootKeyDown: React.KeyboardEventHandler
  header: {
    isCurrentMonth: boolean
    isCurrentYear: boolean
    shiftMonth: (delta: number) => void
    shiftYear: (delta: number) => void
    jumpToCurrentMonth: () => void
    jumpToCurrentYear: () => void
  }
  monthView: MonthViewBundle
  yearView: YearViewBundle
  weekView: WeekViewBundle
}

export function useActivityCalendar(props: ActivityCalendarProps): CalendarHook {
  const state = useCalendarState(props.columnsPreference === 'auto')
  const flash = useCalendarFlash(props.jumpFlash ?? 0, props.view)
  const base = useCalendarBase(props, state)
  const month = useCalendarMonth(props, state, base)
  const year = useCalendarYear(props, state)
  const strip = useCalendarStrip(props, base, state)
  const latest = useCalendarLatest(props)
  const nav = useCalendarNav(props, base, flash)
  const monthHandlers = useMonthGridHandlers(props, state, month)
  const yearHandlers = useYearGridHandlers(props, state, base, nav, flash)
  const stripHandlers = useStripHandlers(props, state, strip, latest, flash)
  useRangeDragFinish(props, state)
  return {
    view: props.view,
    onViewChange: props.onViewChange,
    rootRef: state.rootRef,
    onRootKeyDown: useRootKeyHandler(props, state),
    header: {
      isCurrentMonth: base.isCurrentMonth,
      isCurrentYear: base.isCurrentYear,
      shiftMonth: nav.shiftMonth,
      shiftYear: nav.shiftYear,
      jumpToCurrentMonth: nav.jumpToCurrentMonth,
      jumpToCurrentYear: nav.jumpToCurrentYear,
    },
    monthView: buildMonthView(props, state, base, month, latest, monthHandlers, stripHandlers, flash),
    yearView: buildYearView(props, state, base, year, nav, yearHandlers),
    weekView: buildWeekView(props, state, base, strip, latest, stripHandlers, flash),
  }
}
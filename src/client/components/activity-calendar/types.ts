// Shared hook state shapes for the activity calendar. Kept in their own module
// so use-calendar-handlers.ts can consume them without importing the main hook
// module (which imports the handlers back — a module cycle).
import type { DateRangeFilter } from '@shared/types'
import { latestEditOutsideWindow } from '../../features/list/gap-indicator'
import type { WeekCell } from './strip'
import type { YearGridColumns } from '../calendar-grids'

export interface CalendarState {
  expandedWeek: number | null
  setExpandedWeek: React.Dispatch<React.SetStateAction<number | null>>
  expandedDay: string | null
  setExpandedDay: React.Dispatch<React.SetStateAction<string | null>>
  isExpandedWeekNotes: boolean
  setIsExpandedWeekNotes: React.Dispatch<React.SetStateAction<boolean>>
  focusedKey: string | null
  setFocusedKey: React.Dispatch<React.SetStateAction<string | null>>
  focusedMonth: number | null
  setFocusedMonth: React.Dispatch<React.SetStateAction<number | null>>
  dragRange: DateRangeFilter | null
  setDragRange: React.Dispatch<React.SetStateAction<DateRangeFilter | null>>
  yearRangeAnchor: { year: number; month: number } | null
  setYearRangeAnchor: React.Dispatch<React.SetStateAction<{ year: number; month: number } | null>>
  yearRangeHover: number | null
  setYearRangeHover: React.Dispatch<React.SetStateAction<number | null>>
  pendingFocus: string | null
  setPendingFocus: React.Dispatch<React.SetStateAction<string | null>>
  lastExpandedWeek: React.MutableRefObject<number | null>
  lastExpandedDay: React.MutableRefObject<string | null>
  dragStartKey: React.MutableRefObject<string | null>
  dragHoverKey: React.MutableRefObject<string | null>
  rootRef: React.RefObject<HTMLDivElement | null>
  measuredColumns: YearGridColumns | null
}

export interface FlashState {
  monthFlashRef: React.RefObject<HTMLDivElement | null>
  weekFlashRef: React.RefObject<HTMLDivElement | null>
  flash: () => void
  flashNonce: number
}

export interface CalendarBase {
  now: Date
  todayKey: string
  isCurrentMonth: boolean
  isCurrentYear: boolean
  weekdayLabels: string[]
  gridTitle: string
  monthLabels: string[]
  yearColumns: YearGridColumns
  focusMonth: number
}

export interface MonthState {
  inMonthKeys: string[]
  focusKey: string
  cellMeta: { byKey: Map<string, number>; max: number }
  inRange: (key: string) => boolean
}

export interface StripState {
  stripWeeks: WeekCell[][]
  weekCells: WeekCell[] | undefined
  weekCellsTotal: number
  shownWeek: number | null
  shownDay: string | null
}

export interface LatestState {
  latestEditOutside: ReturnType<typeof latestEditOutsideWindow>
  latestEditOutsideKey: string | null
  latestOutsideDays: number | null
  isLatestOutside: (key: string) => boolean
  gapAhead: boolean
  dayLabel: (key: string) => string
  flaggedLabel: (key: string) => string
  gapLabel: (key: string) => string
}
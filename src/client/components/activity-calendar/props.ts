import type { DateRangeFilter } from '@shared/types'
import type { WeekStartDay } from '../../lib/time'
import type { CalendarDayNote } from './strip'
import type { YearGridColumnsPref } from '../calendar-grids'



export interface ActivityCalendarProps {
  counts: ReadonlyMap<string, number>
  notesByDay?: ReadonlyMap<string, CalendarDayNote[]>
  getDiaryId?: (key: string) => string | null
  locale: string
  weekStart?: WeekStartDay
  today?: Date
  range?: { start: Date; end: Date }
  selectedRange?: DateRangeFilter | null
  latestEditKey?: string | null
  view: 'month' | 'weeks' | 'year'
  onViewChange: (view: 'month' | 'weeks' | 'year') => void
  cursor: { year: number; month: number }
  onCursorChange: (cursor: { year: number; month: number }) => void
  onDayClick: (key: string, diaryId: string | null) => void
  onDaySelect: (key: string) => void
  onRangeSelect: (start: string, end: string) => void
  onGapDayClick: (key: string) => void
  onNoteClick: (noteId: string) => void
  columnsPreference?: YearGridColumnsPref
  /** Increments each time an external jump (e.g. a settings-preview click) targets the month view, triggering a fade-in + accent ring flash. */
  jumpFlash?: number
}

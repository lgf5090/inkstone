import { memo, type JSX } from 'react'
import type { ActivityCalendarProps } from './props'
import { useActivityCalendar } from './use-activity-calendar'
import { CalendarHeader } from './header'
import { MonthView } from './month-view'
import { YearView } from './year-view'
import { WeeksView } from './weeks-view'
import { HeatLegend } from './legend'
export { latestEditOutsideWindow } from '../../features/list/gap-indicator'
export { buildStripWeeks, buildYearHeatMeta, yearHeatLevel, HEAT_PERCENTS } from './strip'
export { heatCell } from './heat-cell'
export { monthRangeToKeys } from './range'
export type { BuildStripWeeksOptions, CalendarDayNote, WeekCell, YearHeatMeta } from './strip'

// The calendar's inputs (counts, notesByDay, diary lookup) now keep their
// identity whenever a notes-map commit touches none of the read fields, so a
// shallow memo lets the whole heatmap subtree skip rendering on such commits
// (typing pauses still legitimately rebuild today's slice and re-render).
export const ActivityCalendarMemo = memo(ActivityCalendar)

/** Reusable calendar + activity heatmap: navigable month grid, yearly month columns, and a GitHub-style weekly strip, with optional per-day note lists. */
export function ActivityCalendar(props: ActivityCalendarProps): JSX.Element {
  const cal = useActivityCalendar(props)
  return (<div ref={cal.rootRef} onKeyDown={cal.onRootKeyDown}>
    <CalendarHeader
      view={cal.view}
      onViewChange={cal.onViewChange}
      isCurrentMonth={cal.header.isCurrentMonth}
      isCurrentYear={cal.header.isCurrentYear}
      shiftMonth={cal.header.shiftMonth}
      shiftYear={cal.header.shiftYear}
      jumpToCurrentMonth={cal.header.jumpToCurrentMonth}
      jumpToCurrentYear={cal.header.jumpToCurrentYear}
    />
    {cal.view === 'month' ? <MonthView {...cal.monthView} /> : cal.view === 'year' ? <YearView {...cal.yearView} /> : <WeeksView {...cal.weekView} />}
    <HeatLegend />
  </div>)
}
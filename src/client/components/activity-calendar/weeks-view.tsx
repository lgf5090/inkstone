import type { JSX } from 'react'
import { WeeksStrip } from './weeks-strip'
import type { WeekViewBundle } from './use-activity-calendar'


type WeeksViewProps = WeekViewBundle

export function WeeksView({ stripWeeks, expandedWeek, shownWeek, expandedDay, shownDay, isExpandedWeekNotes, weekCells, weekCellsTotal, weekdayLabels, flashRef, onStripWeekClick, onToggleDay, onToggleWeekNotes, onActivateDay, onNoteClick, onJumpToDay, isWeekRangeActive, isLatestOutside, gapLabel, flaggedLabel }: WeeksViewProps): JSX.Element {
  return (<WeeksStrip
    stripWeeks={stripWeeks}
    expandedWeek={expandedWeek}
    shownWeek={shownWeek}
    expandedDay={expandedDay}
    shownDay={shownDay}
    isExpandedWeekNotes={isExpandedWeekNotes}
    weekCells={weekCells}
    weekCellsTotal={weekCellsTotal}
    weekdayLabels={weekdayLabels}
    flashRef={flashRef}
    onStripWeekClick={onStripWeekClick}
    onToggleDay={onToggleDay}
    onToggleWeekNotes={onToggleWeekNotes}
    onActivateDay={onActivateDay}
    onNoteClick={onNoteClick}
    onJumpToDay={onJumpToDay}
    isWeekRangeActive={isWeekRangeActive}
    isLatestOutside={isLatestOutside}
    gapLabel={gapLabel}
    flaggedLabel={flaggedLabel}
  />)
}
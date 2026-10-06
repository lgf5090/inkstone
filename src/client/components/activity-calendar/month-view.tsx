import type { JSX } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Tooltip } from '../overlay'
import { MonthGrid } from '../calendar-grids'
import { HEAT_PERCENTS } from './strip'
import type { MonthViewBundle } from './use-activity-calendar'


type MonthViewProps = MonthViewBundle

export function MonthView({ cursor, weekStart, todayKey, weekdayLabels, gridTitle, cellMeta, focusKey, inRange, gapLabel, isLatestOutside, gapAhead, latestOutsideDays, latestOutsideKey, getDiaryId, onGapDayClick, onKeyDown, onMouseDown, onMouseEnter, onActivateDay, onFocusDay, flashRef }: MonthViewProps): JSX.Element {
  return (<>
    <div className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'>
      {latestOutsideKey !== null && (<button type='button' aria-label={t(gapAhead ? 'sidebar.calendar_gap_banner_ahead_value0' : 'sidebar.calendar_gap_banner_value0', { value0: latestOutsideDays ?? 0 })} onClick={() => onGapDayClick(latestOutsideKey)} className='flex h-[var(--sp-6)] w-full items-center gap-[var(--sp-1-5)] rounded-[var(--r-sm)] border border-dashed border-[var(--accent)]/60 bg-[var(--accent-soft)]/60 px-[var(--sp-2)] text-[length:var(--text-10)] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'>
        <RotateCcw size={10} className='shrink-0'/>
        <span className='min-w-0 flex-1 truncate text-left'>{t(gapAhead ? 'sidebar.calendar_gap_banner_ahead_value0' : 'sidebar.calendar_gap_banner_value0', { value0: latestOutsideDays ?? 0 })}</span>
      </button>)}
    </div>
    <div ref={flashRef} className='rounded-[var(--r-md)]'><MonthGrid
      year={cursor.year}
      month={cursor.month}
      weekStart={weekStart}
      todayKey={todayKey}
      weekdayLabels={weekdayLabels}
      ariaLabel={t('sidebar.calendar_month_grid_aria', { value0: gridTitle })}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'
      renderCell={(cell) => {
        const count = cellMeta.byKey.get(cell.key) ?? 0
        const level = count === 0 ? 0 : Math.max(1, Math.round((4 * count) / Math.max(1, cellMeta.max)))
        const diaryId = getDiaryId?.(cell.key) ?? null
        const selected = cell.inMonth && inRange(cell.key)
        return (<Tooltip label={gapLabel(cell.key)}>
          <button type='button' data-day-key={cell.key} tabIndex={cell.key === focusKey ? 0 : -1} aria-pressed={selected} aria-label={gapLabel(cell.key)} onClick={() => {
            onFocusDay(cell.key)
            onActivateDay(cell.key, diaryId)
          }} className={cn('relative flex aspect-square items-center justify-center rounded-[var(--r-xs)] text-[length:var(--text-9-5)] leading-none transition-colors', 'hover:ring-1 hover:ring-inset hover:ring-[var(--accent-ring)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]', cell.today && 'ring-1 ring-inset ring-[var(--accent)]', cell.inMonth ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-quaternary)]', count > 0 && 'font-semibold text-[var(--text-primary)]', isLatestOutside(cell.key) && 'border border-dashed border-[var(--accent)]/80')} style={level > 0 ? { backgroundColor: `color-mix(in oklab, var(--accent) ${HEAT_PERCENTS[level]}%, transparent)` } : undefined}>
            {cell.day}
            {diaryId && (<span aria-hidden='true' className='absolute bottom-[var(--sp-0-5)] left-1/2 size-0.75 -translate-x-1/2 rounded-full bg-[var(--accent)]'/>)}
            {selected && (<span aria-hidden='true' className='absolute inset-x-1 bottom-[1px] h-[var(--sp-0-5)] rounded-full bg-[var(--accent)]'/>)}
          </button>
        </Tooltip>)
      }}
    /></div>
  </>)
}
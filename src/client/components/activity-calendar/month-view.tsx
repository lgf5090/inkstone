import type { JSX } from 'react'
import { RotateCcw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Tooltip } from '../overlay'
import { MonthGrid, type MonthGridCell } from '../calendar-grids'
import { weekOrdinal, type WeekStartDay } from '../../lib/time'
import { useAlmanac } from '../../lib/lunar/almanac-loader'
import type { AlmanacDay } from '../../lib/lunar/festivals'
import { HEAT_PERCENTS } from './strip'
import type { MonthViewBundle } from './use-activity-calendar'


type MonthViewProps = MonthViewBundle

function isWeekend(cell: MonthGridCell): boolean {
  const day = cell.date.getDay()
  return day === 0 || day === 6
}

function WeekNumberCell({ row, weekStart, inRange, onRangeSelect }: {
  row: readonly MonthGridCell[]
  weekStart: WeekStartDay
  inRange: (key: string) => boolean
  onRangeSelect: (start: string, end: string) => void
}) {
  const first = row[0]!
  const last = row[row.length - 1]!
  const { week, year } = weekOrdinal(first.date, weekStart)
  const label = t('sidebar.calendar_week_column_value0', { value0: week, value1: year })
  const active = row.some((cell) => inRange(cell.key))
  return (
    <Tooltip label={label} side='left'>
      <button
        type='button'
        data-week-number={week}
        aria-label={label}
        onClick={() => onRangeSelect(first.key, last.key)}
        className={cn(
          'flex h-full min-h-[var(--sp-4)] items-center justify-center rounded-[var(--r-xs)] text-[length:var(--text-8-5)] tabular leading-none text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
          active && 'font-semibold text-[var(--accent)]',
        )}
      >
        {week}
      </button>
    </Tooltip>
  )
}

function DayCellLabel({ almanac, display }: { almanac: AlmanacDay | null; display: MonthViewProps['display'] }) {
  if (almanac === null)
    return null
  const named = display.festivals ? almanac.highlight : null
  const text = named ? almanac.highlightShort : (display.lunar ? almanac.short : null)
  if (!text)
    return null
  return (
    <span aria-hidden='true' className={cn('max-w-full truncate text-[length:var(--text-8-5)] leading-tight', named ? 'font-medium text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
      {text}
    </span>
  )
}

function almanacSuffix(almanac: AlmanacDay | null, display: MonthViewProps['display']): string {
  if (almanac === null)
    return ''
  const parts = [display.lunar ? almanac.long : '', display.festivals ? almanac.highlight ?? '' : '']
  return parts.filter(Boolean).join(' · ')
}

export function MonthView({ cursor, weekStart, todayKey, weekdayLabels, gridTitle, cellMeta, focusKey, inRange, gapLabel, isLatestOutside, gapAhead, latestOutsideDays, latestOutsideKey, getDiaryId, onGapDayClick, onKeyDown, onMouseDown, onMouseOver, onActivateDay, onFocusDay, flashRef, display, onRangeSelect }: MonthViewProps): JSX.Element {
  const showAlmanac = display.lunar || display.festivals
  const almanac = useAlmanac(showAlmanac)
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
      onMouseOver={onMouseOver}
      className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'
      renderRowHeader={display.weekNumbers ? (_rowIndex, row) => (<WeekNumberCell row={row} weekStart={weekStart} inRange={inRange} onRangeSelect={onRangeSelect}/>) : undefined}
      renderCell={(cell) => {
        if (!cell.inMonth && !display.showAdjacentDays)
          return (<span aria-hidden='true' className='aspect-square w-full'/>)
        const count = cellMeta.byKey.get(cell.key) ?? 0
        const level = count === 0 ? 0 : Math.max(1, Math.round((4 * count) / Math.max(1, cellMeta.max)))
        const diaryId = getDiaryId?.(cell.key) ?? null
        const selected = cell.inMonth && inRange(cell.key)
        const weekend = display.weekendTint && isWeekend(cell) && level === 0 && !selected
        const dayAlmanac = almanac !== null && cell.inMonth ? almanac.almanacOf(cell.date) : null
        const suffix = almanacSuffix(dayAlmanac, display)
        const label = suffix ? `${gapLabel(cell.key)} · ${suffix}` : gapLabel(cell.key)
        return (<Tooltip label={label}>
          <button type='button' data-day-key={cell.key} data-day-gap={cell.inMonth ? undefined : ''} tabIndex={cell.key === focusKey ? 0 : -1} aria-pressed={selected} aria-label={label} onClick={() => {
            onFocusDay(cell.key)
            onActivateDay(cell.key, diaryId)
          }} className={cn('relative flex items-center justify-center rounded-[var(--r-xs)] text-[length:var(--text-9-5)] leading-none transition-colors', showAlmanac ? 'min-h-[var(--sp-7)] flex-col gap-[var(--sp-0-5)] py-[var(--sp-0-5)]' : 'aspect-square', 'hover:ring-1 hover:ring-inset hover:ring-[var(--accent-ring)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]', cell.today && 'ring-1 ring-inset ring-[var(--accent)]', cell.inMonth ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-quaternary)]', weekend && 'bg-[var(--bg-inset)]', count > 0 && 'font-semibold text-[var(--text-primary)]', isLatestOutside(cell.key) && 'border border-dashed border-[var(--accent)]/80')} style={level > 0 ? { backgroundColor: `color-mix(in oklab, var(--accent) ${HEAT_PERCENTS[level]}%, transparent)` } : undefined}>
            <span className='tabular'>{cell.day}</span>
            {dayAlmanac !== null && (<DayCellLabel almanac={dayAlmanac} display={display}/>)}
            {diaryId && (<span aria-hidden='true' className={cn('absolute size-0.75 rounded-full bg-[var(--accent)]', showAlmanac ? 'right-[2px] top-[2px]' : 'bottom-[var(--sp-0-5)] left-1/2 -translate-x-1/2')}/>)}
            {selected && (<span aria-hidden='true' className='absolute inset-x-1 bottom-[1px] h-[var(--sp-0-5)] rounded-full bg-[var(--accent)]'/>)}
          </button>
        </Tooltip>)
      }}
    /></div>
  </>)
}

import type { JSX } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { YearGrid } from '../calendar-grids'
import { heatCell } from './heat-cell'
import type { YearViewBundle } from './use-activity-calendar'


type YearViewProps = YearViewBundle

export function YearView({ cursor, weekStart, todayKey, columns, weekdayLabels, monthLabels, yearMeta, yearLevel, focusMonth, yearRangeAnchor, yearRangeHover, onKeyDown, onMonthClick, onWeekdayClick, onAnchorHover }: YearViewProps): JSX.Element {
  return (<>
    <YearGrid
      year={cursor.year}
      weekStart={weekStart}
      todayKey={todayKey}
      columns={columns}
      ariaLabel={t('sidebar.calendar_year_grid_aria', { value0: cursor.year })}
      onKeyDown={onKeyDown}
      className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'
      renderMonth={(month) => {
        const inRangePreview = yearRangeAnchor !== null && yearRangeHover !== null
          && month.month >= Math.min(yearRangeAnchor.month, yearRangeHover)
          && month.month <= Math.max(yearRangeAnchor.month, yearRangeHover)
        return (<div key={month.month} data-month-card={month.month} className={cn('flex min-w-0 flex-col items-center gap-[var(--sp-1)] rounded-[var(--r-xs)] px-px py-[var(--sp-1)] transition-colors hover:bg-[var(--bg-hover)] focus-within:ring-1 focus-within:ring-inset focus-within:ring-[var(--accent)]', inRangePreview && 'bg-[var(--accent-soft)] hover:bg-[var(--accent-soft)]', yearRangeAnchor?.month === month.month && 'ring-1 ring-inset ring-[var(--accent)]')} onMouseEnter={() => { if (yearRangeAnchor !== null) onAnchorHover(month.month); }}>
          <span className='text-[length:var(--text-8-5)] font-medium text-[var(--text-quaternary)]'>{monthLabels[month.month]}</span>
          <span className='grid w-full grid-cols-7 gap-px leading-none'>
            {weekdayLabels.map((label, index) => (<button key={index} type='button' data-weekday={index} tabIndex={month.month === focusMonth ? 0 : -1} aria-label={t('sidebar.calendar_year_weekday_value0', { value0: monthLabels[month.month] ?? '', value1: label })} onClick={() => onWeekdayClick(month.month, index)} className='rounded-[var(--r-1)] py-px text-center text-[length:var(--text-6)] font-medium text-[var(--text-quaternary)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'>
              {label}
            </button>))}
          </span>
          <button type='button' data-month={month.month} tabIndex={month.month === focusMonth ? 0 : -1} aria-label={t('sidebar.calendar_year_month_value0', { value0: monthLabels[month.month] ?? '', value1: yearMeta.totals[month.month] ?? 0 })} onClick={(event) => onMonthClick(event, month.month)} className='grid w-full grid-cols-7 gap-px rounded-[var(--r-2)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'>
            {month.cells.map((cell, index) => (<span key={index} aria-hidden='true' className={cn('aspect-square w-full rounded-[var(--r-1)]', cell.today && 'ring-1 ring-inset ring-[var(--accent)]')} style={heatCell(cell.inMonth ? yearLevel(cell.key) : null)}/>))}
          </button>
        </div>)
      }}
    />
    {yearRangeAnchor !== null && (<div className='mt-[var(--sp-1)] px-[var(--sp-0-5)] text-[length:var(--text-9)] text-[var(--text-tertiary)]'>
      {t('sidebar.calendar_year_range_hint_value0', { value0: monthLabels[yearRangeAnchor.month] ?? '' })}
    </div>)}
  </>)
}
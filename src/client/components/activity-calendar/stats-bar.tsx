import type { JSX } from 'react'
import { t } from '../../lib/i18n'
import type { CalendarStreak, MonthTotals } from '../../lib/calendar-stats'

interface StatsBarProps {
  totals: MonthTotals
  streak: CalendarStreak
}

/**
 * The month's own numbers sit beside the legend rather than under a heading: both answer the same
 * question about the same row of squares, and a reader who wants the ramp explanation already has
 * it in front of them.
 */
export function CalendarStatsBar({ totals, streak }: StatsBarProps): JSX.Element {
  return (
    <div data-calendar-stats className='mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-0-5)] px-[var(--sp-1)] text-[length:var(--text-9)] text-[var(--text-quaternary)]'>
      <span className='tabular'>{t('sidebar.calendar_stat_month_value0', { value0: totals.total })}</span>
      <span className='tabular'>{t('sidebar.calendar_stat_active_value0', { value0: totals.activeDays })}</span>
      {streak.current > 0 && (<span className='tabular font-medium text-[var(--accent)]'>{t('sidebar.calendar_stat_streak_value0', { value0: streak.current })}</span>)}
      {streak.best > streak.current && (<span className='tabular ml-auto'>{t('sidebar.calendar_stat_best_value0', { value0: streak.best })}</span>)}
    </div>
  )
}

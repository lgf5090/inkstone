import type { JSX } from 'react'
import { useMemo } from 'react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { dateKey, dayOfYear, daysInYear, weekOrdinal, type WeekStartDay } from '../../lib/time'
import { almanacOf } from '../../lib/lunar/festivals'

interface TodayCardProps {
  today: Date
  locale: string
  weekStart: WeekStartDay
  showLunar: boolean
  showFestival: boolean
  showWeekNumber: boolean
  onSelectDay: (key: string) => void
}

/**
 * Two lines, always. The sidebar is 196px wide, so a third item on either line would ellipsize the
 * date itself - the one thing this bar exists to say. The right-hand slot of the first line is
 * shared: a festival outranks the week number there because the week column already prints the
 * number when it is on, while nothing else on the calendar names today's feast.
 */
export function TodayCard({ today, locale, weekStart, showLunar, showFestival, showWeekNumber, onSelectDay }: TodayCardProps): JSX.Element {
  const dateLine = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(today), [today, locale])
  const weekdayLine = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(today), [today, locale])
  const week = useMemo(() => weekOrdinal(today, weekStart), [today, weekStart])
  const almanac = useMemo(() => (showLunar || showFestival) ? almanacOf(today) : null, [today, showLunar, showFestival])
  const year = today.getFullYear()
  const day = dayOfYear(today)
  const festival = showFestival ? almanac?.highlight ?? null : null
  const secondary = festival ?? (showWeekNumber ? t('sidebar.calendar_week_number_value0', { value0: week.week }) : null)
  return (
    <div className='mt-[var(--sp-1-5)] px-[var(--sp-0-5)]'>
      <button
        type='button'
        data-calendar-today-card
        aria-label={t('sidebar.calendar_today_card_aria_value0', { value0: `${dateLine} ${weekdayLine}`, value1: almanac?.long ?? '' })}
        onClick={() => onSelectDay(dateKey(today))}
        className='flex w-full flex-col gap-[var(--sp-0-5)] rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-[var(--sp-2)] py-[var(--sp-1-5)] text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
      >
        <span className='flex min-w-0 items-baseline gap-[var(--sp-1-5)]'>
          <span className='shrink-0 text-[length:var(--text-10-5)] font-semibold text-[var(--text-primary)]'>{dateLine}</span>
          <span className='shrink-0 text-[length:var(--text-9-5)] text-[var(--text-tertiary)]'>{weekdayLine}</span>
          {secondary !== null && (<span className={cn('ml-auto shrink-0 truncate text-[length:var(--text-9)]', festival ? 'rounded-full bg-[var(--accent-soft)] px-[var(--sp-1-5)] py-px font-medium text-[var(--accent)]' : 'tabular text-[var(--text-quaternary)]')}>{secondary}</span>)}
        </span>
        {showLunar && almanac !== null && (
          <span className='flex min-w-0 items-baseline gap-[var(--sp-1-5)]'>
            <span className='min-w-0 truncate text-[length:var(--text-9-5)] text-[var(--text-secondary)]'>{almanac.long}</span>
            {almanac.zodiac && (<span className='shrink-0 text-[length:var(--text-9)] text-[var(--text-quaternary)]'>{t('sidebar.calendar_zodiac_value0', { value0: almanac.zodiac })}</span>)}
            <span className='ml-auto shrink-0 tabular text-[length:var(--text-9)] text-[var(--text-quaternary)]'>{t('sidebar.calendar_day_of_year_value0', { value0: day, value1: daysInYear(year) })}</span>
          </span>
        )}
      </button>
    </div>
  )
}

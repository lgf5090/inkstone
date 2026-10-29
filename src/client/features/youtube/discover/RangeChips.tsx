import { TIME_RANGES, type TimeRange } from '@shared/youtube/model'
import type { MessageKey } from '@shared/locales/en-US'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'

export const RANGE_LABELS: Record<TimeRange, MessageKey> = {
  today: 'youtube.range.today',
  week: 'youtube.range.week',
  month: 'youtube.range.month',
  quarter: 'youtube.range.quarter',
  year: 'youtube.range.year',
  all: 'youtube.range.all',
}

export function RangeChips({ value, onChange }: { value: TimeRange; onChange: (range: TimeRange) => void }) {
  return (
    <div className="-mx-px flex gap-1 overflow-x-auto px-3 py-1.5 [scrollbar-width:none]">
      {TIME_RANGES.map((range) => {
        const active = range === value
        return (
          <button
            key={range}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(range)}
            className={cn(
              'inline-flex h-7 shrink-0 items-center rounded-[var(--r-full)] border px-[var(--sp-2-5)]',
              'text-[length:var(--text-11)] font-medium whitespace-nowrap',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
              active
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {t(RANGE_LABELS[range])}
          </button>
        )
      })}
    </div>
  )
}

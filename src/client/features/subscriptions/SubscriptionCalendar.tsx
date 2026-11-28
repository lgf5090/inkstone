import { useMemo, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t, useLocale } from '../../lib/i18n'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { formatLocalDate } from '@shared/subscriptions/time'
import type { SubscriptionItem } from '@shared/subscriptions/model'

interface CalendarEntry {
  id: string
  name: string
  kind: 'expiry' | 'trial'
}

const DAYS_PER_WEEK = 7
const MAX_VISIBLE_EVENTS = 3

function entriesByDay(items: readonly SubscriptionItem[], timezone: string): Map<string, CalendarEntry[]> {
  const entries = new Map<string, CalendarEntry[]>()
  for (const item of items) {
    if (!item.isActive) continue
    const expiry = formatLocalDate(item.expiryDate, timezone, 'date')
    const list = entries.get(expiry) ?? []
    list.push({ id: item.id, name: item.name, kind: 'expiry' })
    entries.set(expiry, list)
    if (item.trialEndsAt) {
      const trial = formatLocalDate(item.trialEndsAt, timezone, 'date')
      const trials = entries.get(trial) ?? []
      trials.push({ id: item.id, name: item.name, kind: 'trial' })
      entries.set(trial, trials)
    }
  }
  return entries
}

export function SubscriptionCalendar({ items, timezone, onOpenItem }: {
  items: readonly SubscriptionItem[]
  timezone: string
  onOpenItem: (id: string) => void
}): ReactElement {
  const locale = useLocale()
  const today = formatLocalDate(Date.now(), timezone, 'date')
  const [cursor, setCursor] = useState(() => {
    const [year, month] = today.split('-').map(Number)
    return { year, month }
  })
  const entries = useMemo(() => entriesByDay(items, timezone), [items, timezone])
  const days = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor])
  const monthLabel = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(cursor.year, cursor.month - 1, 1)))
  const weekdays = useMemo(() => Array.from({ length: DAYS_PER_WEEK }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index))),
  ), [locale])

  const move = (offset: number): void => {
    setCursor((current) => {
      const date = new Date(Date.UTC(current.year, current.month - 1 + offset, 1))
      return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 }
    })
  }

  if (items.length === 0) {
    return <Empty art="subscriptions" title={t('subscriptions.overview.empty')} description={t('subscriptions.overview.empty_hint')} />
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto px-3 pb-8 pt-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <SectionLabel>{monthLabel}</SectionLabel>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setCursor({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })}>
            {t('subscriptions.calendar.today')}
          </Button>
          <IconButton label={t('subscriptions.calendar.previous')} size="sm" onClick={() => move(-1)}><ChevronLeft size={15} /></IconButton>
          <IconButton label={t('subscriptions.calendar.next')} size="sm" onClick={() => move(1)}><ChevronRight size={15} /></IconButton>
        </div>
      </div>
      <div role="table" aria-label={monthLabel} className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)]">
        <div role="row" className="grid grid-cols-7 border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
          {weekdays.map((day) => (
            <div key={day} role="columnheader" className="px-1 py-1.5 text-center text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{day}</div>
          ))}
        </div>
        {Array.from({ length: days.length / DAYS_PER_WEEK }, (_, row) => (
          <div key={row} role="row" className="grid grid-cols-7">
            {days.slice(row * DAYS_PER_WEEK, row * DAYS_PER_WEEK + DAYS_PER_WEEK).map((day, index) => {
              const dayEntries = day ? entries.get(day) ?? [] : []
              return (
                <div
                  key={day ?? `empty-${row}-${index}`}
                  role="cell"
                  aria-label={day ?? undefined}
                  className={cn(
                    'min-h-20 min-w-0 border-b border-r border-[var(--border-subtle)] p-1 last:border-r-0',
                    !day && 'bg-[var(--bg-inset)]',
                    day === today && 'bg-[var(--accent-soft)]',
                  )}
                >
                  {day && (
                    <>
                      <span aria-current={day === today ? 'date' : undefined} className={cn('text-[length:var(--text-10-5)] tabular-nums', day === today ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>{Number(day.slice(8))}</span>
                      <div className="mt-0.5 space-y-0.5">
                        {dayEntries.slice(0, MAX_VISIBLE_EVENTS).map((entry) => (
                          <button
                            key={`${entry.id}-${entry.kind}`}
                            type="button"
                            onClick={() => onOpenItem(entry.id)}
                            className={cn(
                              'block w-full truncate rounded-[var(--r-xs)] px-1 py-0.5 text-left text-[length:var(--text-10)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                              entry.kind === 'trial' ? 'bg-[var(--warning-soft)] text-[var(--warning)]' : 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]',
                            )}
                            title={`${entry.name} · ${t(entry.kind === 'trial' ? 'subscriptions.detail.trial_ends' : 'subscriptions.detail.expiry')}`}
                          >
                            {entry.name}
                          </button>
                        ))}
                        {dayEntries.length > MAX_VISIBLE_EVENTS && <span className="block px-1 text-[length:var(--text-10)] text-[var(--text-quaternary)]">+{dayEntries.length - MAX_VISIBLE_EVENTS}</span>}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function monthGrid(year: number, month: number): Array<string | null> {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (first.getUTCDay() + 6) % DAYS_PER_WEEK
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: Array<string | null> = Array.from({ length: offset }, () => null)
  for (let day = 1; day <= count; day++) cells.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  while (cells.length % DAYS_PER_WEEK !== 0) cells.push(null)
  return cells
}

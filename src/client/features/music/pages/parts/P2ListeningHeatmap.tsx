/**
 * A compact GitHub-style strip of listening activity.
 *
 * The server keeps at most a hundred recent plays, so the strip records the activity this page can
 * actually see rather than implying a complete year. Cells are decorative; the wrapper carries one
 * sentence for a screen reader and each cell repeats its date through `title` for the pointer.
 */
import { useMemo, type ReactElement } from 'react'
import { cn } from '../../../../lib/cn'
import { musicText } from '../../components/labels'
import { formatDate } from './P2QueryState'

export interface ListeningHeatmapEntry {
  playedAt: number
}

interface HeatmapDay {
  key: string
  date: Date
  count: number
}

const DAYS_PER_WEEK = 7

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function buildDays(entries: readonly ListeningHeatmapEntry[], weeks: number, today: Date): HeatmapDay[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!Number.isFinite(entry.playedAt) || entry.playedAt <= 0) continue
    const key = dayKey(new Date(entry.playedAt))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const end = startOfDay(today)
  // Monday is the first column so a week reads as a working week rather than starting on Sunday.
  const mondayOffset = (end.getDay() + 6) % DAYS_PER_WEEK
  const lastMonday = new Date(end)
  lastMonday.setDate(end.getDate() - mondayOffset)
  const start = new Date(lastMonday)
  start.setDate(lastMonday.getDate() - (weeks - 1) * DAYS_PER_WEEK)

  const days: HeatmapDay[] = []
  const total = weeks * DAYS_PER_WEEK
  for (let index = 0; index < total; index++) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = dayKey(date)
    days.push({ key, date, count: counts.get(key) ?? 0 })
  }
  return days
}

function levelOf(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 6) return 3
  return 4
}

const LEVEL_CLASS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'bg-[var(--bg-inset)]',
  1: 'bg-[var(--accent)] opacity-25',
  2: 'bg-[var(--accent)] opacity-45',
  3: 'bg-[var(--accent)] opacity-70',
  4: 'bg-[var(--accent)]',
}

export function ListeningHeatmap({
  entries,
  weeks = 52,
  className,
}: {
  entries: readonly ListeningHeatmapEntry[]
  weeks?: number
  className?: string
}): ReactElement {
  const today = useMemo(() => new Date(), [])
  const days = useMemo(() => buildDays(entries, weeks, today), [entries, weeks, today])

  return (
    <div className={cn('flex flex-col gap-[var(--sp-2)]', className)}>
      <div className="overflow-x-auto pb-[var(--sp-1)]">
        <div
          role="img"
          aria-label={musicText('music.history.heatmap_summary', { count: entries.length })}
          className="grid w-max grid-flow-col grid-rows-7 gap-[3px]"
        >
          {days.map((day) => (
            <span
              key={day.key}
              aria-hidden="true"
              title={musicText('music.history.heatmap_day', {
                date: formatDate(day.date.getTime()),
                count: day.count,
              })}
              className={cn('size-[10px] rounded-[2px]', LEVEL_CLASS[levelOf(day.count)])}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-[var(--sp-1-5)] text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        <span>{musicText('music.history.heatmap_less')}</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span key={level} aria-hidden="true" className={cn('size-[10px] rounded-[2px]', LEVEL_CLASS[level])} />
        ))}
        <span>{musicText('music.history.heatmap_more')}</span>
      </div>
    </div>
  )
}

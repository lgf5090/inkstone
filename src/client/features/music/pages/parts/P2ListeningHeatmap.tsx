/**
 * A GitHub-style strip of listening activity.
 *
 * The server already grouped plays by the reader's local calendar day, so this component only lays
 * those counts out. Cells are decorative and repeat their date through `title`; the wrapper carries
 * one sentence for a screen reader, which keeps a year of squares out of the tab order.
 */
import { useMemo, type ReactElement } from 'react'
import { useLocale } from '../../../../lib/i18n'
import { cn } from '../../../../lib/cn'
import { musicText } from '../../components/labels'
import { formatDate } from './P2QueryState'

export const MUSIC_HEATMAP_PALETTES = ['green', 'blue', 'orange', 'purple', 'red'] as const
export type MusicHeatmapPalette = (typeof MUSIC_HEATMAP_PALETTES)[number]

export interface ListeningHeatmapDay {
  date: string
  count: number
}

interface HeatmapDay {
  key: string
  date: Date
  count: number
  future: boolean
}

const DAYS_PER_WEEK = 7
const WEEKDAY_ROWS = [0, 2, 4] as const


function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function buildDays(
  counts: ReadonlyMap<string, number>,
  weeks: number,
  today: Date,
): HeatmapDay[] {
  const end = startOfDay(today)
  // Monday is the first column so a week reads as a working week rather than starting on Sunday.
  const mondayOffset = (end.getDay() + 6) % DAYS_PER_WEEK
  const lastMonday = new Date(end)
  lastMonday.setDate(end.getDate() - mondayOffset)
  const start = new Date(lastMonday)
  start.setDate(lastMonday.getDate() - (weeks - 1) * DAYS_PER_WEEK)

  const days: HeatmapDay[] = []
  for (let index = 0; index < weeks * DAYS_PER_WEEK; index++) {
    const date = new Date(start)
    date.setDate(start.getDate() + index)
    const key = dayKey(date)
    days.push({
      key,
      date,
      count: counts.get(key) ?? 0,
      future: date.getTime() > end.getTime(),
    })
  }
  return days
}

function levelOf(count: number): 1 | 2 | 3 | 4 {
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 6) return 3
  return 4
}

export function ListeningHeatmap({
  days,
  weeks = 52,
  palette = 'green',
  showMonths = false,
  fill = false,
  className,
}: {
  days: readonly ListeningHeatmapDay[]
  weeks?: number
  palette?: MusicHeatmapPalette
  showMonths?: boolean
  fill?: boolean
  className?: string
}): ReactElement {
  const locale = useLocale()
  const today = useMemo(() => new Date(), [])
  const counts = useMemo(
    () => new Map(days.filter((day) => day.count > 0).map((day) => [day.date, day.count])),
    [days],
  )
  const cells = useMemo(() => buildDays(counts, weeks, today), [counts, weeks, today])
  const weekdays = useMemo(
    () => WEEKDAY_ROWS.map((row) => new Intl.DateTimeFormat(locale, { weekday: 'short' })
      .format(cells[row]?.date ?? today)),
    [cells, locale, today],
  )
  const months = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { month: 'short' })
    const segments: Array<{ key: string; label: string; span: number }> = []
    for (let week = 0; week < weeks; week++) {
      const first = cells[week * DAYS_PER_WEEK]?.date
      if (!first) continue
      const key = `${first.getFullYear()}-${first.getMonth()}`
      const last = segments.at(-1)
      if (last?.key === key || (last === undefined && segments.length > 0)) {
        if (last) last.span += 1
      } else {
        segments.push({ key, label: formatter.format(first), span: 1 })
      }
    }
    return segments
  }, [cells, locale, weeks])
  const total = useMemo(() => days.reduce((sum, day) => sum + day.count, 0), [days])

  return (
    <div className={cn('flex flex-col gap-[var(--sp-2)]', className)}>
      <div className="overflow-x-auto pb-[var(--sp-1)]">
        <div className={fill ? 'w-full' : 'w-max'}>
          {showMonths && (
            <div className="ms-[28px] flex h-[16px] items-end text-[length:var(--text-10)] text-[var(--text-quaternary)]">
              {months.map((month) => (
                <span
                  key={month.key}
                  className="shrink-0 overflow-hidden whitespace-nowrap"
                  style={{ width: `${month.span * 15}px` }}
                >
                  {month.label}
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-[var(--sp-1-5)]">
            <div
              aria-hidden="true"
              className="grid grid-rows-7 gap-[3px] pt-px text-[length:var(--text-9-5)] leading-[12px] text-[var(--text-quaternary)]"
            >
              {Array.from({ length: DAYS_PER_WEEK }, (_, row) => (
                <span key={row} className="w-[22px] text-end">
                  {WEEKDAY_ROWS.includes(row as 0 | 2 | 4) ? weekdays[WEEKDAY_ROWS.indexOf(row as 0 | 2 | 4)] : ''}
                </span>
              ))}
            </div>
            <div
              role="img"
              aria-label={musicText('music.history.heatmap_summary', { count: total })}
              className={cn(
                'music-heatmap grid w-max grid-flow-col grid-rows-7 gap-[3px]',
                fill && 'music-heatmap--fill',
                `music-heatmap--${palette}`,
              )}
            >
              {cells.map((day) => (
                <span
                  key={day.key}
                  aria-hidden="true"
                  title={musicText('music.history.heatmap_day', {
                    date: formatDate(day.date.getTime()),
                    count: day.count,
                  })}
                  className={cn(
                    'size-[12px] rounded-[2px]',
                    day.future ? 'bg-transparent' : day.count > 0 ? `music-heatmap__cell--${levelOf(day.count)}` : 'music-heatmap__cell--0',
                  )}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-[var(--sp-1-5)] text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        <span>{musicText('music.history.heatmap_less')}</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <span
            key={level}
            aria-hidden="true"
            className={cn(
              'music-heatmap size-[10px] rounded-[2px]',
              `music-heatmap--${palette}`,
              level === 0 ? 'music-heatmap__cell--0' : `music-heatmap__cell--${level}`,
            )}
          />
        ))}
        <span>{musicText('music.history.heatmap_more')}</span>
      </div>
    </div>
  )
}

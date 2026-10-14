/**
 * The habit, in one place.
 *
 * A reader keeps this open for the same reason they keep a running log: today's minutes against the goal
 * they set, and whether the streak is alive. Everything here is derived from the per-book day log the
 * timer writes, so deleting a book can neither invent a day nor lose one.
 */
import { Tooltip } from '../../../components/overlay'
import { t } from '../../../lib/i18n'
import { dayKey, formatReadingSeconds } from '../format-time'
import { summariseStats } from '../reading-stats'
import { useLibrary } from '../store/library'

const WINDOW_DAYS = 14

export interface StatsPanelProps {
  bookId: string
  goalMinutes: number
}

export function StatsPanel({ bookId, goalMinutes }: StatsPanelProps) {
  const stats = useLibrary((state) => state.stats)
  const books = useLibrary((state) => state.books)
  const summary = summariseStats(stats, dayKey())
  const goalSeconds = Math.max(0, goalMinutes) * 60
  const peak = Math.max(1, ...summary.recent.map((one) => one.seconds))
  const titles = new Map(books.map((one) => [one.id, one.title || one.filename]))

  return (
    <div className="px-3 py-2">
      {summary.totalSeconds === 0 ? (
        <p className="py-6 text-center text-[length:var(--text-12)] opacity-60">{t('reading.stats_none')}</p>
      ) : null}

      {goalSeconds > 0 ? (
        <div className="mb-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[length:var(--text-12-5)]">{t('reading.today')}</span>
            <span className="text-[length:var(--text-11)] tabular opacity-60">
              {summary.todaySeconds >= goalSeconds
                ? t('reading.stats_goal_done')
                : t('reading.stats_goal_left_value0', { value0: formatReadingSeconds(goalSeconds - summary.todaySeconds) })}
            </span>
          </div>
          <div className="mt-1 h-[6px] rounded-full bg-current opacity-15">
            <div
              className="h-full rounded-full bg-current opacity-70"
              style={{ width: `${Math.min(100, (summary.todaySeconds / goalSeconds) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}

      <dl className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Cell label={t('reading.stats_streak')} value={summary.streakDays ? `${summary.streakDays}` : '—'} />
        <Cell label={t('reading.stats_days_read')} value={`${summary.daysRead}`} />
        <Cell label={t('reading.stats_library')} value={formatReadingSeconds(summary.totalSeconds)} />
        <Cell label={t('reading.stats_average')} value={formatReadingSeconds(summary.averagePerDay)} />
        <Cell label={t('reading.stats_this_book')} value={formatReadingSeconds(stats[bookId]?.seconds ?? 0)} />
        {summary.best ? (
          <Cell label={t('reading.stats_best_day')} value={`${formatDay(summary.best.day)} · ${formatReadingSeconds(summary.best.seconds)}`} />
        ) : null}
      </dl>

      <p className="mb-1 text-[length:var(--text-11)] opacity-55">{t('reading.stats_last_days', { value0: WINDOW_DAYS })}</p>
      <div className="mb-3 flex items-end gap-[3px]" role="img" aria-label={t('reading.stats_last_days', { value0: WINDOW_DAYS })}>
        {summary.recent.map((one) => (
          <Tooltip key={one.day} label={`${one.day} · ${formatReadingSeconds(one.seconds)}`} side="top">
            <div
              className="flex-1 rounded-t-[2px] bg-current"
              style={{ height: `${Math.max(2, Math.round((one.seconds / peak) * 46))}px`, opacity: one.seconds ? 0.7 : 0.15 }}
            />
          </Tooltip>
        ))}
      </div>

      {summary.perBook.length ? (
        <ul className="space-y-1">
          <li className="text-[length:var(--text-11)] opacity-55">{t('reading.stats_by_book')}</li>
          {summary.perBook.map((one) => (
            <li key={one.bookId} className="flex items-baseline gap-2 text-[length:var(--text-12)]">
              <span className="min-w-0 flex-1 truncate">{titles.get(one.bookId) ?? one.bookId}</span>
              <span className="shrink-0 tabular opacity-60">{formatReadingSeconds(one.seconds)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[length:var(--text-10-5)] opacity-55">{label}</dt>
      <dd className="truncate text-[length:var(--text-13)] tabular">{value}</dd>
    </div>
  )
}

/** A day key back into the reader's own calendar words, anchored at noon so no timezone shifts it. */
function formatDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`))
}

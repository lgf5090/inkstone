import { useId, useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { CalendarDays, ChevronDown, ChevronRight } from 'lucide-react'
import { heatCell } from '../../../components/activity-calendar/heat-cell'
import { Skeleton } from '../../../components/feedback'
import { Button, SectionLabel } from '../../../components/primitives'
import { TooltipIconButton } from '../../../components/tooltip-icon-button'
import { usePathname } from '../../../lib/app-history'
import { cn } from '../../../lib/cn'
import { t, useLocale } from '../../../lib/i18n'
import { dateKey, formatDateKey, weekStartFor } from '../../../lib/time'
import { memosApi } from '../api'
import {
  buildMemoMonthCells,
  memoCalendarPath,
  memoMonthGridRows,
  memoMonthHeatLevels,
  memoMonthRangeSeconds,
  memoTimeZone,
  resolveMemoCalendarDate,
} from '../calendar-model'
import { useRevision } from '../events'
import { parseMemoPath, type MemoRoute } from '../route'
import { useMemoResource } from '../use-resource'
import { navigateMemoUrl } from '../url-state'

function routeSpaceId(route: MemoRoute): string | null {
  return route.kind === 'space' || route.kind === 'calendar' || route.kind === 'attachments' || route.kind === 'map'
    ? route.spaceId
    : null
}

function StatValue({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[length:var(--text-9-5)] text-[var(--text-quaternary)]">{label}</dt>
      <dd className="mt-0.5 text-[length:var(--text-13)] font-semibold tabular text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  )
}

function TypeCount({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="flex items-center gap-1">
      <dt className="text-[length:var(--text-9-5)] text-[var(--text-quaternary)]">{label}</dt>
      <dd className="text-[length:var(--text-10-5)] tabular text-[var(--text-secondary)]">{value}</dd>
    </div>
  )
}

export function StatsSection(): ReactElement {
  const pathname = usePathname()
  const locale = useLocale()
  const route = useMemo(() => parseMemoPath(pathname), [pathname])
  const [expanded, setExpanded] = useState(true)
  const detailsId = useId()
  const spaceId = routeSpaceId(route)
  const revision = useRevision('stats')
  const timeZone = useMemo(memoTimeZone, [])
  const now = new Date()
  const selection = resolveMemoCalendarDate(route.kind === 'calendar' ? route.date : null, now)
  const todayKey = dateKey(now)
  const range = useMemo(
    () => memoMonthRangeSeconds(selection.year, selection.month, timeZone),
    [selection.year, selection.month, timeZone],
  )
  const stats = useMemoResource(
    (signal) => memosApi.stats.get({
      spaceId,
      from: range.start,
      to: range.end,
      tz: range.timeZone,
      timeBasis: 'created',
    }, signal),
    [spaceId, range.start, range.end, range.timeZone, revision],
  )
  const cells = useMemo(
    () => buildMemoMonthCells(selection.year, selection.month, weekStartFor(locale), todayKey),
    [selection.year, selection.month, locale, todayKey],
  )
  const rows = useMemo(() => memoMonthGridRows(cells), [cells])
  const monthKeys = useMemo(
    () => cells.filter((cell) => cell.inMonth).map((cell) => cell.key),
    [cells],
  )
  const levels = useMemo(
    () => memoMonthHeatLevels(stats.data?.dayCounts ?? {}, monthKeys),
    [stats.data, monthKeys],
  )
  const monthTotal = useMemo(
    () => monthKeys.reduce((total, key) => total + (stats.data?.dayCounts[key] ?? 0), 0),
    [monthKeys, stats.data],
  )
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' })
      .format(new Date(selection.year, selection.month - 1, 1)),
    [locale, selection.year, selection.month],
  )
  const calendarPath = memoCalendarPath(spaceId, {
    year: selection.year,
    month: selection.month,
  })
  const data = stats.data
  const pending = stats.status === 'loading' && data === null
  const failed = stats.status === 'error' && data === null

  const openCalendar = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigateMemoUrl(calendarPath, '')
  }

  return (
    <div className="pt-2">
      <div className="flex items-center gap-0.5 pr-1">
        <SectionLabel className="flex-1">{t('memos.nav.stats')}</SectionLabel>
        {data !== null ? (
          <TooltipIconButton
            label={t(expanded ? 'memos.stats.collapse' : 'memos.stats.expand')}
            tooltipSide="left"
            size="xs"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </TooltipIconButton>
        ) : null}
      </div>
      {pending ? (
        <>
          <p role="status" aria-live="polite" className="sr-only">
            {t('memos.common.loading')}
          </p>
          <div className="mx-2 mt-1 space-y-1" aria-hidden="true">
            <Skeleton className="h-9 rounded-[var(--r-md)]" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-12 rounded-[var(--r-sm)]" />
          </div>
        </>
      ) : null}
      {failed ? (
        <div className="px-2 py-1">
          <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
            {t('memos.stats.error')}
          </p>
          <Button size="sm" variant="ghost" className="mt-1 h-7 px-1.5" onClick={stats.reload}>
            {t('memos.common.retry')}
          </Button>
        </div>
      ) : null}
      {data !== null ? (
        <div className="mx-2 mt-1 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2">
          {stats.status === 'error' ? (
            <div role="alert" className="mb-1.5 flex items-center gap-1">
              <span className="min-w-0 flex-1 text-[length:var(--text-10-5)] text-[var(--danger)]">
                {t('memos.stats.error')}
              </span>
              <Button size="sm" variant="ghost" className="h-6 shrink-0 px-1" onClick={stats.reload}>
                {t('memos.common.retry')}
              </Button>
            </div>
          ) : null}
          <dl className="grid grid-cols-3 gap-1">
            <StatValue label={t('memos.stats.total')} value={data.total} />
            <StatValue label={t('memos.stats.archived')} value={data.archived} />
            <StatValue label={t('memos.stats.comments')} value={data.comments} />
          </dl>
          <dl className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">
            <TypeCount label={t('memos.stats.links')} value={data.typeCounts.link} />
            <TypeCount label={t('memos.stats.code')} value={data.typeCounts.code} />
            <TypeCount label={t('memos.stats.tasks')} value={data.typeCounts.todo} />
            <TypeCount label={t('memos.stats.open_tasks')} value={data.typeCounts.undo} />
          </dl>
          {expanded ? (
            <div id={detailsId} className="mt-1.5 border-t border-[var(--border-subtle)] pt-1.5">
              <p className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
                  {monthLabel}
                </span>
                <span className="shrink-0 text-[length:var(--text-9-5)] tabular text-[var(--text-quaternary)]">
                  {t(monthTotal === 1 ? 'memos.stats.month_total_one' : 'memos.stats.month_total', {
                    count: monthTotal,
                  })}
                </span>
              </p>
              {monthTotal > 0 ? (
                <div
                  role="img"
                  aria-label={t('memos.stats.month_heat', { month: monthLabel })}
                  className="mt-1 space-y-[var(--sp-0-5)]"
                >
                  {rows.map((row) => (
                    <div
                      key={row[0]?.key ?? ''}
                      className="grid grid-cols-7 gap-[var(--sp-0-5)]"
                    >
                      {row.map((cell) => {
                        if (!cell.inMonth) {
                          return <span key={cell.key} aria-hidden="true" className="aspect-square w-full" />
                        }
                        const level = levels.get(cell.key) ?? 0
                        const count = data.dayCounts[cell.key] ?? 0
                        return (
                          <span
                            key={cell.key}
                            data-memo-stats-day={cell.key}
                            title={t('memos.stats.day_count', {
                              date: formatDateKey(cell.key),
                              count,
                            })}
                            className={cn(
                              'aspect-square w-full rounded-[var(--r-2)]',
                              level === 0 && 'bg-[var(--bg-inset)]',
                              cell.today && 'ring-1 ring-inset ring-[var(--accent)]',
                            )}
                            style={level > 0 ? heatCell(level) : undefined}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]">
                  {t('memos.stats.month_empty')}
                </p>
              )}
              <a
                href={calendarPath}
                onClick={openCalendar}
                className="mt-1 flex min-h-8 items-center gap-1 rounded-[var(--r-sm)] px-1 text-[length:var(--text-10-5)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] md:min-h-0 md:h-6"
              >
                <CalendarDays size={11} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t('memos.stats.open_calendar')}</span>
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

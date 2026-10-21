import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { MEMO_MAX_PAGE_SIZE, MEMOS_APP_PATH } from '@shared/memos/constants'
import type { Memo } from '@shared/memos/types'
import { heatCell } from '../../../components/activity-calendar/heat-cell'
import { Empty, Skeleton } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { Button, IconButton } from '../../../components/primitives'
import { usePathname } from '../../../lib/app-history'
import { cn } from '../../../lib/cn'
import { t, useLocale } from '../../../lib/i18n'
import {
  dateKey,
  formatDateKey,
  fullTime,
  narrowWeekdayLabels,
  parseDateKey,
  weekStartFor,
} from '../../../lib/time'
import { memosApi } from '../api'
import {
  addMemoCalendarDays,
  buildMemoMonthCells,
  daysInMemoMonth,
  groupMemosByDay,
  memoCalendarDateKey,
  memoCalendarPath,
  memoDayStartSeconds,
  memoMonthGridRows,
  memoMonthHeatLevels,
  memoMonthRangeSeconds,
  memoTimeZone,
  resolveMemoCalendarDate,
  shiftMemoCalendarMonth,
  type MemoCalendarSelection,
  type MemoMonthCell,
} from '../calendar-model'
import { MemoComposer } from '../components/MemoComposer'
import { useRevision } from '../events'
import { parseMemoPath } from '../route'
import { useMemoResource } from '../use-resource'
import { navigateMemoUrl, useMemoSearch } from '../url-state'

const NO_DAY_MEMOS: readonly Memo[] = []
const CALENDAR_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <div
      role="alert"
      className="mt-2 flex items-center gap-2 rounded-[var(--r-md)] bg-[var(--danger-soft)] px-2.5 py-1.5"
    >
      <span className="min-w-0 flex-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
        {message}
      </span>
      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-1.5" onClick={onRetry}>
        {t('memos.common.retry')}
      </Button>
    </div>
  )
}

export interface MemoCalendarPageProps {
  onOpenMemo?: (id: string) => void
}

export function MemoCalendarPage({ onOpenMemo }: MemoCalendarPageProps): ReactElement {
  const pathname = usePathname()
  const search = useMemoSearch()
  const locale = useLocale()
  const route = useMemo(() => parseMemoPath(pathname), [pathname])
  const spaceId = route.kind === 'calendar' ? route.spaceId : null
  const selection = resolveMemoCalendarDate(
    route.kind === 'calendar' ? route.date : null,
    new Date(),
  )
  const timeZone = useMemo(memoTimeZone, [])
  const weekStart = weekStartFor(locale)
  const todayKey = dateKey(new Date())
  const selectedKey = memoCalendarDateKey(selection)
  const query = search.startsWith('?') ? search.slice(1) : search
  const monthHeadingId = useId()
  const dayHeadingId = useId()
  const listRevision = useRevision('list')
  const statsRevision = useRevision('stats')
  const dayButtons = useRef(new Map<string, HTMLButtonElement>())
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)

  const range = useMemo(
    () => memoMonthRangeSeconds(selection.year, selection.month, timeZone),
    [selection.year, selection.month, timeZone],
  )
  const monthMemos = useMemoResource(
    (signal) => memosApi.list({
      filter: `created_ts >= ${range.start} && created_ts < ${range.end}`,
      limit: MEMO_MAX_PAGE_SIZE,
      orderBy: 'created',
      order: 'asc',
      spaceId,
    }, signal),
    [range.start, range.end, spaceId, listRevision],
  )
  const stats = useMemoResource(
    (signal) => memosApi.stats.get({
      from: range.start,
      to: range.end,
      tz: range.timeZone,
      timeBasis: 'created',
      spaceId,
    }, signal),
    [range.start, range.end, range.timeZone, spaceId, statsRevision],
  )

  useEffect(() => {
    if (!selection.invalidDay) return
    navigateMemoUrl(memoCalendarPath(spaceId, selection), query, { replace: true })
  }, [selection.invalidDay, selection.year, selection.month, selection.day, spaceId, query])

  const cells = useMemo(
    () => buildMemoMonthCells(selection.year, selection.month, weekStart, todayKey),
    [selection.year, selection.month, weekStart, todayKey],
  )
  const rows = useMemo(() => memoMonthGridRows(cells), [cells])
  const monthKeys = useMemo(
    () => cells.filter((cell) => cell.inMonth).map((cell) => cell.key),
    [cells],
  )

  useEffect(() => {
    if (pendingFocus === null) return
    const button = dayButtons.current.get(pendingFocus)
    if (!button) return
    button.focus()
    setPendingFocus(null)
  }, [pendingFocus, cells])

  const levels = useMemo(
    () => memoMonthHeatLevels(stats.data?.dayCounts ?? {}, monthKeys),
    [stats.data, monthKeys],
  )
  const memosByDay = useMemo(
    () => groupMemosByDay(monthMemos.data?.items ?? [], timeZone),
    [monthMemos.data, timeZone],
  )
  const monthMemosInView = useMemo(
    () => monthKeys.flatMap((key) => memosByDay.get(key) ?? []),
    [monthKeys, memosByDay],
  )
  const dayMemos = memosByDay.get(selectedKey) ?? NO_DAY_MEMOS
  const monthCount = monthMemosInView.length
  const listLoading = monthMemos.data === null
    || (monthMemos.status === 'loading' && monthCount === 0)
  const listFailed = monthMemos.status === 'error' && monthCount === 0
  const monthEmpty = monthMemos.status === 'ready' && monthCount === 0
  const truncated = monthMemos.status === 'ready'
    && monthCount > 0
    && Boolean(monthMemos.data?.nextCursor)
  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' })
      .format(new Date(selection.year, selection.month - 1, 1)),
    [locale, selection.year, selection.month],
  )
  const weekdayLabels = useMemo(
    () => narrowWeekdayLabels(locale, weekStart),
    [locale, weekStart],
  )
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }),
    [locale],
  )

  const navigateTo = (next: MemoCalendarSelection, replace = false): void => {
    navigateMemoUrl(memoCalendarPath(spaceId, next), query, { replace })
  }

  const shiftMonth = (delta: number): void => {
    const next = shiftMemoCalendarMonth(selection, delta)
    setPendingFocus(memoCalendarDateKey(next))
    navigateTo(next)
  }

  const goToday = (): void => {
    const now = new Date()
    const next = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
    setPendingFocus(memoCalendarDateKey(next))
    navigateTo(next)
  }

  const selectCell = (cell: MemoMonthCell): void => {
    const date = parseDateKey(cell.key)
    setPendingFocus(cell.key)
    navigateTo({
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
    })
  }

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!CALENDAR_KEYS.includes(event.key)) return
    const target = event.target
    if (!(target instanceof Element) || target.closest('[data-memo-calendar-day]') === null) return
    event.preventDefault()
    let next: MemoCalendarSelection
    if (event.key === 'Home') {
      next = { year: selection.year, month: selection.month, day: 1 }
    } else if (event.key === 'End') {
      next = {
        year: selection.year,
        month: selection.month,
        day: daysInMemoMonth(selection.year, selection.month),
      }
    } else {
      const delta = event.key === 'ArrowLeft'
        ? -1
        : event.key === 'ArrowRight'
          ? 1
          : event.key === 'ArrowUp'
            ? -7
            : 7
      next = addMemoCalendarDays(selection, delta)
    }
    setPendingFocus(memoCalendarDateKey(next))
    navigateTo(next)
  }

  const openMemo = (id: string): void => {
    if (onOpenMemo) {
      onOpenMemo(id)
      return
    }
    navigateMemoUrl(`${MEMOS_APP_PATH}/m/${encodeURIComponent(id)}`, query)
  }

  const openMemoLink = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    openMemo(id)
  }

  const dayLabel = (cell: MemoMonthCell, count: number): string => {
    const date = formatDateKey(cell.key)
    if (count === 0) return t('memos.calendar.day_label_empty', { date })
    if (count === 1) return t('memos.calendar.day_label_one', { date })
    return t('memos.calendar.day_label', { date, count })
  }

  const monthCountLabel = listLoading
    ? t('memos.common.loading')
    : t(monthCount === 1 ? 'memos.calendar.month_count_one' : 'memos.calendar.month_count', {
        count: monthCount,
      })
  const dayCountLabel = listLoading
    ? t('memos.common.loading')
    : t(
        dayMemos.length === 1 ? 'memos.calendar.day_count_one' : 'memos.calendar.day_count',
        { count: dayMemos.length },
      )
  const composerTimestamp = selectedKey === todayKey
    ? Math.floor(Date.now() / 1000)
    : memoDayStartSeconds(selection.year, selection.month, selection.day, timeZone)

  return (
    <div className="flex h-full min-h-0 flex-col" data-memos-calendar="">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1200px] px-3 py-3 md:px-5 md:py-4">
          <h2 className="text-[length:var(--text-15)] font-semibold text-[var(--text-primary)]">
            {t('memos.nav.calendar')}
          </h2>
          <div className="mt-3 grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
            <section
              aria-labelledby={monthHeadingId}
              aria-busy={listLoading || stats.status === 'loading'}
              className="min-w-0 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <IconButton
                  label={t('memos.calendar.previous_month')}
                  size="sm"
                  onClick={() => shiftMonth(-1)}
                >
                  <ChevronLeft size={14} />
                </IconButton>
                <h3
                  id={monthHeadingId}
                  className="min-w-0 flex-1 truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]"
                >
                  {monthLabel}
                </h3>
                <IconButton
                  label={t('memos.calendar.next_month')}
                  size="sm"
                  onClick={() => shiftMonth(1)}
                >
                  <ChevronRight size={14} />
                </IconButton>
                <Button size="sm" variant="secondary" onClick={goToday}>
                  {t('memos.calendar.today')}
                </Button>
              </div>
              <p
                role="status"
                aria-live="polite"
                className="mt-0.5 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]"
              >
                {monthCountLabel}
              </p>
              {stats.status === 'error' ? (
                <InlineError
                  message={t('memos.calendar.stats_error')}
                  onRetry={stats.reload}
                />
              ) : null}
              {monthMemos.status === 'error' && monthCount > 0 ? (
                <InlineError
                  message={t('memos.calendar.error_description')}
                  onRetry={monthMemos.reload}
                />
              ) : null}
              <div
                role="grid"
                aria-label={t('memos.calendar.grid_label', { month: monthLabel })}
                onKeyDown={handleGridKeyDown}
                className="mt-2 select-none"
              >
                <div role="row" className="grid grid-cols-7 gap-[var(--sp-0-5)]">
                  {weekdayLabels.map((label, index) => (
                    <div
                      key={`${label}-${index}`}
                      role="columnheader"
                      className="flex items-center justify-center text-[length:var(--text-9)] font-medium text-[var(--text-quaternary)]"
                    >
                      {label}
                    </div>
                  ))}
                </div>
                {rows.map((row) => (
                  <div
                    key={row[0]?.key ?? ''}
                    role="row"
                    className="mt-[var(--sp-0-5)] grid grid-cols-7 gap-[var(--sp-0-5)]"
                  >
                    {row.map((cell) => {
                      const count = cell.inMonth ? stats.data?.dayCounts[cell.key] ?? 0 : 0
                      const level = cell.inMonth ? levels.get(cell.key) ?? 0 : 0
                      const selected = cell.key === selectedKey
                      const label = dayLabel(cell, count)
                      return (
                        <div
                          key={cell.key}
                          role="gridcell"
                          aria-selected={selected}
                          className="min-w-0"
                        >
                          <button
                            ref={(node) => {
                              if (node) dayButtons.current.set(cell.key, node)
                              else dayButtons.current.delete(cell.key)
                            }}
                            type="button"
                            data-memo-calendar-day={cell.key}
                            tabIndex={selected ? 0 : -1}
                            aria-current={cell.today ? 'date' : undefined}
                            aria-label={label}
                            title={label}
                            onClick={() => selectCell(cell)}
                            className={cn(
                              'flex aspect-square w-full min-w-0 flex-col items-center justify-center rounded-[var(--r-sm)] text-[length:var(--text-9-5)] leading-none transition-colors',
                              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]',
                              cell.inMonth
                                ? 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                                : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)]',
                              count > 0 && 'font-semibold text-[var(--text-primary)]',
                              selected && 'ring-2 ring-inset ring-[var(--accent)]',
                              cell.today && !selected && 'ring-1 ring-inset ring-[var(--accent-ring)]',
                            )}
                            style={level > 0 ? heatCell(level) : undefined}
                          >
                            <span className="tabular">{cell.day}</span>
                            {count > 0 ? (
                              <span aria-hidden="true" className="text-[length:var(--text-8-5)] tabular">
                                {count}
                              </span>
                            ) : null}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
              <div
                aria-hidden="true"
                className="mt-2 flex items-center justify-end gap-1 text-[length:var(--text-9)] text-[var(--text-quaternary)]"
              >
                <span>{t('memos.calendar.heat_less')}</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <span
                    key={level}
                    className="size-[var(--sp-2-5)] rounded-[var(--r-xs)]"
                    style={heatCell(level)}
                  />
                ))}
                <span>{t('memos.calendar.heat_more')}</span>
              </div>
              {truncated ? (
                <p
                  role="status"
                  className="mt-1 text-[length:var(--text-10-5)] leading-relaxed text-[var(--text-quaternary)]"
                >
                  {t('memos.calendar.truncated')}
                </p>
              ) : null}
            </section>
            <section
              aria-labelledby={dayHeadingId}
              className="min-w-0 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h3
                    id={dayHeadingId}
                    className="truncate text-[length:var(--text-13-5)] font-semibold text-[var(--text-primary)]"
                  >
                    {formatDateKey(selectedKey)}
                  </h3>
                  <p className="mt-0.5 text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
                    {dayCountLabel}
                  </p>
                </div>
                <Button size="sm" variant="primary" onClick={() => setComposerOpen(true)}>
                  <Plus size={13} aria-hidden="true" />
                  {t('memos.calendar.new_memo')}
                </Button>
              </div>
              {listLoading ? (
                <>
                  <p role="status" aria-live="polite" className="sr-only">
                    {t('memos.common.loading')}
                  </p>
                  <div className="mt-2 space-y-1.5" aria-hidden="true">
                    <Skeleton className="h-10 rounded-[var(--r-md)]" />
                    <Skeleton className="h-10 rounded-[var(--r-md)]" />
                    <Skeleton className="h-10 rounded-[var(--r-md)]" />
                  </div>
                </>
              ) : null}
              {listFailed ? (
                <Empty
                  compact
                  art="notes"
                  title={t('memos.calendar.error_title')}
                  description={monthMemos.error ?? t('memos.calendar.error_description')}
                  action={(
                    <Button size="sm" onClick={monthMemos.reload}>
                      {t('memos.common.retry')}
                    </Button>
                  )}
                />
              ) : null}
              {!listLoading && !listFailed && monthEmpty ? (
                <Empty
                  compact
                  art="notes"
                  title={t('memos.calendar.month_empty_title')}
                  description={t('memos.calendar.month_empty_description')}
                  action={(
                    <Button size="sm" onClick={() => setComposerOpen(true)}>
                      {t('memos.calendar.new_memo')}
                    </Button>
                  )}
                />
              ) : null}
              {!listLoading && !listFailed && !monthEmpty && dayMemos.length === 0 ? (
                <Empty
                  compact
                  art="notes"
                  title={t('memos.calendar.day_empty_title')}
                  description={t('memos.calendar.day_empty_description')}
                  action={(
                    <Button size="sm" onClick={() => setComposerOpen(true)}>
                      {t('memos.calendar.new_memo')}
                    </Button>
                  )}
                />
              ) : null}
              {dayMemos.length > 0 ? (
                <ul className="mt-2 space-y-0.5">
                  {dayMemos.map((memo) => {
                    const preview = memo.snippet.trim() || memo.content.trim()
                    const href = `${MEMOS_APP_PATH}/m/${encodeURIComponent(memo.id)}`
                    const time = timeFormatter.format(new Date(memo.createdAt * 1000))
                    return (
                      <li key={memo.id}>
                        <a
                          href={href}
                          onClick={(event) => openMemoLink(event, memo.id)}
                          className="flex min-h-10 items-start gap-2 rounded-[var(--r-md)] px-1.5 py-1.5 transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          <time
                            dateTime={new Date(memo.createdAt * 1000).toISOString()}
                            title={fullTime(memo.createdAt * 1000)}
                            className="w-[var(--sp-12)] shrink-0 pt-0.5 text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]"
                          >
                            {time}
                          </time>
                          <span className="line-clamp-2 min-w-0 flex-1 break-words text-[length:var(--text-12)] leading-snug text-[var(--text-secondary)]">
                            {preview || t('memos.calendar.memo_no_text')}
                          </span>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </section>
          </div>
        </div>
      </div>
      <Modal
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        title={t('memos.calendar.new_title', { date: formatDateKey(selectedKey) })}
        description={t('memos.calendar.new_description')}
        width={640}
      >
        <MemoComposer
          key={selectedKey}
          initialCreatedAt={composerTimestamp}
          spaceId={spaceId}
          onSaved={() => setComposerOpen(false)}
          onCancel={() => setComposerOpen(false)}
        />
      </Modal>
    </div>
  )
}

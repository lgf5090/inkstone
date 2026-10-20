/**
 * The statistics screen: one range of the account's finished and filed work.
 *
 * The screen is a thin reading of `GET /api/todos/stats`. It never derives a number from the tasks it
 * happens to hold — the server measures in the account's own days, and a second implementation here
 * would disagree the moment a page is incomplete or a zone changes. What the browser decides is only
 * the range: the presets and the bucket are calendar arithmetic on the day strings the answer echoes,
 * and every move is written into the address so a reload or the back button opens the same question.
 *
 * The trend is an inline SVG rather than a charting dependency: two series over at most ninety points
 * is less work than a library's setup, and the inline drawing can carry an `aria-label` and a real
 * table beside it. Colour is never the only distinction — the created line is dashed and both series
 * are named in a legend and in the table's header.
 */
import { useEffect } from 'react'
import { localDate } from '@shared/assistant-time'
import type {
  TaskStatsBucket,
  TodoStats,
} from '@shared/todos/model'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Segmented } from '../../components/form'
import { localeTag, t } from '../../lib/i18n'
import { shiftDay } from './due-range'
import {
  countDeltaPercent,
  previousRange,
  rateDeltaPoints,
  usePreviousStats,
  type PreviousStats,
} from './stats-compare'
import { downloadStatsCsv } from './stats-csv'
import { PRIORITIES, listName, priorityLabel, tagName, weekdayName } from './stats-format'
import { useTodos } from './store'

const RANGE_CHOICES = [
  { value: '7', labelKey: 'todo.stats.range.7', days: 7 },
  { value: '30', labelKey: 'todo.stats.range.30', days: 30 },
  { value: '90', labelKey: 'todo.stats.range.90', days: 90 },
] as const

type RangeChoice = (typeof RANGE_CHOICES)[number]['value']

/** Up to two weeks a day is still a readable curve; past that the days are too thin to tell apart. */
const DAILY_BUCKET_MAX_DAYS = 14

const BUCKETS: readonly TaskStatsBucket[] = ['day', 'week', 'month']
const BUCKET_LABELS: Record<TaskStatsBucket, MessageKey> = {
  day: 'todo.stats.bucket.day',
  week: 'todo.stats.bucket.week',
  month: 'todo.stats.bucket.month',
}

const MINUTE_MS = 60_000

/** The range a preset means in the account's calendar: inclusive days ending today. */
function rangeFor(days: number, today: string): { from: string; to: string; bucket: TaskStatsBucket } {
  return {
    from: shiftDay(today, -(days - 1)),
    to: today,
    bucket: days <= DAILY_BUCKET_MAX_DAYS ? 'day' : 'week',
  }
}

/** Which preset the range on screen spells, or null for a shared address that names another window. */
function presetOf(range: { from: string; to: string } | null, today: string): RangeChoice | null {
  if (!range) return null
  for (const choice of RANGE_CHOICES) {
    const candidate = rangeFor(choice.days, today)
    if (candidate.from === range.from && candidate.to === range.to) return choice.value
  }
  return null
}

function integer(value: number): string {
  return new Intl.NumberFormat(localeTag()).format(value)
}

function decimal(value: number): string {
  return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 1 }).format(value)
}

function percent(rate: number): string {
  return new Intl.NumberFormat(localeTag(), { style: 'percent', maximumFractionDigits: 0 }).format(rate)
}

/** A duration in the words a reader would use, not in milliseconds. */
function duration(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = ms / MINUTE_MS
  if (minutes < 60) return t('todo.stats.duration.minutes', { value: integer(Math.max(1, Math.round(minutes))) })
  const hours = minutes / 60
  if (hours < 24) return t('todo.stats.duration.hours', { value: decimal(hours) })
  return t('todo.stats.duration.days', { value: decimal(hours / 24) })
}

/** The bar width a share means; a tag share may pass one and is drawn at a full bar. */
function widthOf(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0'
  return String(Math.min(100, Math.round(share * 100)))
}

interface BarRow {
  key: string
  label: string
  value: number
  /** The number printed beside the bar: a share of the range's completions. */
  share: number
  /** How much of the track the bar fills; weekday and hour rows scale to the busiest bucket. */
  width: number
}

function BarList({ label, rows }: { label: string; rows: BarRow[] }) {
  if (!rows.length) {
    return <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.stats.distribution.empty')}</p>
  }
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {rows.map((row) => (
        <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-[length:var(--text-12)] text-[var(--text-secondary)]">{row.label}</span>
          <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
            {integer(row.value)} · {percent(row.share)}
          </span>
          <span aria-hidden="true" className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]">
            <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${widthOf(row.width)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function DistributionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <h3 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  )
}

function Kpi({ id, label, value, hint }: { id: string; label: string; value: string; hint?: string }) {
  return (
    <div data-stats-kpi={id} className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="mt-0.5 text-[length:var(--text-20)] font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
      {hint && <dd className="mt-0.5 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{hint}</dd>}
    </div>
  )
}

function Kpis({ stats }: { stats: TodoStats }) {
  const { summary, leadTime } = stats
  const net = `${summary.net > 0 ? '+' : ''}${integer(summary.net)}`
  return (
    <section aria-labelledby="todo-stats-overview">
      <h2 id="todo-stats-overview" className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
        {t('todo.stats.overview')}
      </h2>
      <dl className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi id="completed" label={t('todo.stats.completed')} value={integer(summary.completed)} />
        <Kpi id="created" label={t('todo.stats.created')} value={integer(summary.created)} />
        <Kpi id="net" label={t('todo.stats.net')} value={net} />
        <Kpi
          id="completion_rate"
          label={t('todo.stats.completion_rate')}
          value={percent(summary.completionRate)}
          hint={t('todo.stats.completion_rate_hint', { completed: summary.completed, open: summary.open })}
        />
        <Kpi
          id="on_time"
          label={t('todo.stats.on_time')}
          value={summary.onTimeDue === 0 ? '—' : percent(summary.onTimeRate)}
          hint={t('todo.stats.on_time_hint', { onTime: summary.onTime, due: summary.onTimeDue })}
        />
        <Kpi
          id="median_lead"
          label={t('todo.stats.median_lead')}
          value={duration(summary.medianLeadTimeMs)}
          hint={t('todo.stats.median_lead_hint', { value: duration(leadTime.p90) })}
        />
        <Kpi
          id="streak"
          label={t('todo.stats.streak')}
          value={t('todo.stats.days', { value: summary.currentStreak })}
          hint={t('todo.stats.streak_hint', { days: summary.longestStreak })}
        />
        <Kpi
          id="overdue"
          label={t('todo.stats.overdue')}
          value={integer(summary.overdue)}
          hint={t('todo.stats.overdue_hint')}
        />
      </dl>
    </section>
  )
}

function Legend({ label, color, dashed = false }: { label: string; color: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
      <svg aria-hidden="true" width="18" height="8" viewBox="0 0 18 8">
        <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      {label}
    </span>
  )
}

function TrendChart({ stats }: { stats: TodoStats }) {
  const { series, summary, range } = stats
  const width = 640
  const height = 160
  const padX = 6
  const padTop = 8
  const plotWidth = width - padX * 2
  const plotHeight = height - padTop
  const max = Math.max(1, ...series.flatMap((point) => [point.completed, point.created]))
  const x = (index: number): number => (
    series.length <= 1 ? padX + plotWidth / 2 : padX + (index / (series.length - 1)) * plotWidth
  )
  const y = (value: number): number => padTop + plotHeight - (value / max) * plotHeight
  const points = (key: 'completed' | 'created'): string => (
    series.map((point, index) => `${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ')
  )
  const label = t('todo.stats.trend.chart_label', {
    from: range.from,
    to: range.to,
    completed: summary.completed,
    created: summary.created,
  })
  return (
    <section aria-labelledby="todo-stats-trend" className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <h2 id="todo-stats-trend" className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
        {t('todo.stats.trend.title')}
      </h2>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Legend label={t('todo.stats.completed')} color="var(--accent)" />
        <Legend label={t('todo.stats.created')} color="var(--text-tertiary)" dashed />
      </div>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="mt-2 h-40 w-full"
      >
        <title>{label}</title>
        <line
          x1={padX}
          y1={height - 1}
          x2={width - padX}
          y2={height - 1}
          stroke="var(--border-default)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          points={points('completed')}
        />
        <polyline
          fill="none"
          stroke="var(--text-tertiary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
          points={points('created')}
        />
        {series.length === 1 && (
          <circle cx={x(0)} cy={y(series[0]!.completed)} r="2.5" fill="var(--accent)" />
        )}
      </svg>
      <table className="sr-only" data-stats-series="">
        <caption>{t('todo.stats.trend.table_caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('todo.stats.trend.column.period')}</th>
            <th scope="col">{t('todo.stats.completed')}</th>
            <th scope="col">{t('todo.stats.created')}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((point) => (
            <tr key={point.day}>
              <th scope="row">{point.day}</th>
              <td>{point.completed}</td>
              <td>{point.created}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Distributions({ stats }: { stats: TodoStats }) {
  const { distributions, summary } = stats
  const total = summary.completed
  const busiestWeekday = Math.max(1, ...distributions.byWeekday.map((entry) => entry.completed))
  const busiestHour = Math.max(1, ...distributions.byHour.map((entry) => entry.completed))
  return (
    <section aria-labelledby="todo-stats-distributions">
      <h2 id="todo-stats-distributions" className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
        {t('todo.stats.distributions')}
      </h2>
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        <DistributionCard title={t('todo.stats.by_list')}>
          <BarList
            label={t('todo.stats.by_list')}
            rows={distributions.byList.map((entry) => ({
              key: entry.id ?? 'inbox',
              label: listName(entry),
              value: entry.completed,
              share: entry.share,
              width: entry.share,
            }))}
          />
        </DistributionCard>
        <DistributionCard title={t('todo.stats.by_tag')}>
          <BarList
            label={t('todo.stats.by_tag')}
            rows={distributions.byTag.map((entry) => ({
              key: entry.id ?? entry.name ?? 'tag',
              label: tagName(entry),
              value: entry.completed,
              share: entry.share,
              width: entry.share,
            }))}
          />
        </DistributionCard>
        <DistributionCard title={t('todo.stats.by_priority')}>
          <BarList
            label={t('todo.stats.by_priority')}
            rows={PRIORITIES.map((priority) => {
              const entry = distributions.byPriority.find((row) => row.priority === priority)
              return {
                key: priority,
                label: priorityLabel(priority),
                value: entry?.completed ?? 0,
                share: entry?.share ?? 0,
                width: entry?.share ?? 0,
              }
            })}
          />
        </DistributionCard>
        <DistributionCard title={t('todo.stats.by_weekday')}>
          <BarList
            label={t('todo.stats.by_weekday')}
            rows={distributions.byWeekday.map((entry) => ({
              key: String(entry.weekday),
              label: weekdayName(entry.weekday),
              value: entry.completed,
              share: total > 0 ? entry.completed / total : 0,
              width: entry.completed / busiestWeekday,
            }))}
          />
        </DistributionCard>
        <details className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:col-span-2">
          <summary className="flex min-h-11 cursor-pointer items-center text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
            {t('todo.stats.by_hour')}
          </summary>
          <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('todo.stats.by_hour_note')}</p>
          <div className="mt-2">
            <BarList
              label={t('todo.stats.by_hour')}
              rows={distributions.byHour.map((entry) => ({
                key: String(entry.hour),
                label: String(entry.hour).padStart(2, '0'),
                value: entry.completed,
                share: total > 0 ? entry.completed / total : 0,
                width: entry.completed / busiestHour,
              }))}
            />
          </div>
        </details>
      </div>
    </section>
  )
}

function Backlog({ stats }: { stats: TodoStats }) {
  const { backlog } = stats
  const total = backlog.under7 + backlog.days7to30 + backlog.over30 + backlog.none
  const rows: BarRow[] = [
    { key: 'under7', label: t('todo.stats.backlog.under7'), value: backlog.under7 },
    { key: 'days7to30', label: t('todo.stats.backlog.7to30'), value: backlog.days7to30 },
    { key: 'over30', label: t('todo.stats.backlog.over30'), value: backlog.over30 },
    { key: 'none', label: t('todo.stats.backlog.none'), value: backlog.none },
  ].map((row) => ({
    ...row,
    share: total > 0 ? row.value / total : 0,
    width: total > 0 ? row.value / total : 0,
  }))
  return (
    <section aria-labelledby="todo-stats-backlog" className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <h2 id="todo-stats-backlog" className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
        {t('todo.stats.backlog.title')}
      </h2>
      <p className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('todo.stats.backlog.hint')}</p>
      <div className="mt-2">
        <BarList label={t('todo.stats.backlog.title')} rows={rows} />
      </div>
    </section>
  )
}

/** A signed number in the reader's digits: `+33`, `-5`, `0`; the formatter picks the unit. */
function signed(value: number, format: (magnitude: number) => string): string {
  if (value > 0) return `+${format(value)}`
  if (value < 0) return `-${format(-value)}`
  return format(0)
}

/** A count's change as a whole percent; a dash when the earlier window held nothing to divide by. */
function countChange(current: number, previous: number): string {
  const change = countDeltaPercent(current, previous)
  if (change === null) return '—'
  return signed(Math.round(change), (magnitude) => `${integer(magnitude)}%`)
}

/** A rate's change in percentage points, one decimal at most; a dash without an earlier denominator. */
function pointsChange(currentRate: number, previousRate: number, previousDenominator: number): string {
  const change = rateDeltaPoints(currentRate, previousRate, previousDenominator)
  if (change === null) return '—'
  return t('todo.stats.compare.points', { value: signed(Math.round(change * 10) / 10, decimal) })
}

function Delta({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <dt className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</dt>
      <dd
        data-stats-delta={id}
        className="mt-0.5 text-[length:var(--text-16)] font-semibold tabular-nums text-[var(--text-primary)]"
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * The same four headline numbers against the equally long window before this one.
 *
 * A failure is contained here: the current range's KPIs are not the comparison's to take down. And a
 * window that held nothing prints a dash for the count it cannot divide and for the rate it cannot
 * place — never an infinity dressed up as a percentage.
 */
function Comparison({ stats, comparison }: { stats: TodoStats; comparison: PreviousStats }) {
  const { summary } = stats
  const previous = comparison.status === 'ready' ? comparison.stats : null
  const window = comparison.range ?? previousRange(stats.range)
  const rows = [
    {
      id: 'completed',
      label: t('todo.stats.completed'),
      value: previous ? countChange(summary.completed, previous.summary.completed) : '—',
    },
    {
      id: 'created',
      label: t('todo.stats.created'),
      value: previous ? countChange(summary.created, previous.summary.created) : '—',
    },
    {
      id: 'completion_rate',
      label: t('todo.stats.completion_rate'),
      // The open count behind a completion rate is a snapshot taken now, not a count of the earlier
      // window, so a period with no completions of its own offers no rate to compare against: it is a
      // dash, not a jump from a borrowed zero.
      value: previous && previous.summary.completed > 0
        ? pointsChange(
          summary.completionRate,
          previous.summary.completionRate,
          previous.summary.completed + previous.summary.open,
        )
        : '—',
    },
    {
      id: 'on_time',
      label: t('todo.stats.on_time'),
      value: previous
        ? pointsChange(summary.onTimeRate, previous.summary.onTimeRate, previous.summary.onTimeDue)
        : '—',
    },
  ]
  return (
    <section aria-labelledby="todo-stats-compare" data-stats-compare={comparison.status}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h2 id="todo-stats-compare" className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">
          {t('todo.stats.compare.title')}
        </h2>
        <p className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
          {window.from} – {window.to}
        </p>
      </div>
      {comparison.status === 'loading' && (
        <p role="status" className="mt-1 text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('todo.stats.compare.loading')}
        </p>
      )}
      {comparison.status === 'unavailable' && (
        <p role="status" className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">
          {t('todo.stats.compare.unavailable')}
          {comparison.error ? ` · ${comparison.error}` : ''}
          {' · '}
          {t('todo.stats.compare.unavailable_hint')}
        </p>
      )}
      <dl className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {rows.map((row) => <Delta key={row.id} {...row} />)}
      </dl>
    </section>
  )
}

function StatsBody({ stats, comparison }: { stats: TodoStats; comparison: PreviousStats }) {
  return (
    <div className="flex flex-col gap-5">
      <Kpis stats={stats} />
      <Comparison stats={stats} comparison={comparison} />
      <TrendChart stats={stats} />
      <Distributions stats={stats} />
      <Backlog stats={stats} />
    </div>
  )
}

function StatsError({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
      <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{t('todo.stats.error')}</p>
      {error && <p className="mt-1 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-tertiary)]">{error}</p>}
      <Button size="lg" className="mt-3 min-h-11" onClick={onRetry}>{t('todo.stats.retry')}</Button>
    </div>
  )
}

/**
 * The CSV download, worded beside the range it describes.
 *
 * An empty range has no rows to hand over, so the button stays in place but disabled and the hint
 * says why — a control that disappeared would leave the reader wondering whether they missed it.
 */
function StatsExport({ stats }: { stats: TodoStats }) {
  const empty = stats.summary.completed === 0 && stats.summary.created === 0
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="lg"
        className="min-h-11"
        disabled={empty}
        aria-describedby="todo-stats-export-hint"
        onClick={() => { downloadStatsCsv(stats) }}
      >
        {t('todo.stats.export.label')}
      </Button>
      <p id="todo-stats-export-hint" className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">
        {empty ? t('todo.stats.export.empty') : t('todo.stats.export.hint', { zone: stats.range.timezone })}
      </p>
    </div>
  )
}

/** The range and the bucket controls, which are the only state the statistics screen owns. */
function StatsControls({ stats, onRange, onBucket }: {
  stats: TodoStats
  onRange: (choice: RangeChoice) => void
  onBucket: (bucket: TaskStatsBucket) => void
}) {
  const today = localDate(Date.now(), stats.range.timezone)
  const preset = presetOf(stats.range, today)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<RangeChoice | 'custom'>
          label={t('todo.stats.range.label')}
          value={preset ?? 'custom'}
          options={RANGE_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }))}
          onChange={(value) => { if (value !== 'custom') onRange(value) }}
          // A finger's height on every target: the segmented row is the screen's primary control.
          className="[&_button]:min-h-11"
        />
        <Segmented<TaskStatsBucket>
          label={t('todo.stats.bucket.label')}
          value={stats.range.bucket}
          options={BUCKETS.map((bucket) => ({ value: bucket, label: t(BUCKET_LABELS[bucket]) }))}
          onChange={onBucket}
          className="[&_button]:min-h-11"
        />
      </div>
      <p className="text-[length:var(--text-11)] leading-relaxed tabular-nums text-[var(--text-quaternary)]">
        {stats.range.from} – {stats.range.to}
        {preset === null ? ` · ${t('todo.stats.range.custom')}` : ''}
        {' · '}
        {t('todo.stats.timezone_note', { zone: stats.range.timezone })}
      </p>
    </div>
  )
}

export function StatsView() {
  const stats = useTodos((state) => state.stats)
  const status = useTodos((state) => state.statsStatus)
  const error = useTodos((state) => state.statsError)
  const statsFrom = useTodos((state) => state.statsFrom)
  const statsTo = useTodos((state) => state.statsTo)
  const statsBucket = useTodos((state) => state.statsBucket)
  const loadStats = useTodos((state) => state.loadStats)
  const setStatsRange = useTodos((state) => state.setStatsRange)

  // The comparison reads the range the address names, not the range the last answer described: on a
  // move it must leave together with the new request, not wait for it to echo the days back. A shared
  // address that names no bucket waits for the first answer, which is the only place the bucket is
  // known until the reader picks one.
  const bucket = statsBucket ?? stats?.range.bucket ?? null
  const comparison = usePreviousStats(
    statsFrom && statsTo && bucket ? { from: statsFrom, to: statsTo, bucket } : null,
  )

  useEffect(() => {
    // The container reads the listing on every mount, but not the statistics: this screen asks for
    // its own answer the first time it is shown, and keeps it on screen while another range lands.
    if (useTodos.getState().statsStatus === 'idle') void loadStats()
  }, [loadStats])

  const pickRange = (choice: RangeChoice): void => {
    const days = RANGE_CHOICES.find((entry) => entry.value === choice)!.days
    const zone = stats?.range.timezone ?? useTodos.getState().timezone
    setStatsRange(rangeFor(days, localDate(Date.now(), zone)))
  }

  const pickBucket = (bucket: TaskStatsBucket): void => {
    if (!stats) return
    setStatsRange({ from: stats.range.from, to: stats.range.to, bucket })
  }

  return (
    <div
      data-stats-view=""
      aria-busy={status === 'loading' || undefined}
      className="flex flex-col gap-4 px-3 pb-6 pt-3 md:px-5"
    >
      {stats && <StatsControls stats={stats} onRange={pickRange} onBucket={pickBucket} />}
      {stats && <StatsExport stats={stats} />}
      {status === 'error' ? (
        <StatsError error={error} onRetry={() => { void loadStats() }} />
      ) : !stats ? (
        <LoadingBlock label={t('todo.stats.loading')} />
      ) : stats.summary.completed === 0 && stats.summary.created === 0 ? (
        <Empty title={t('todo.stats.empty')} description={t('todo.stats.empty_hint')} />
      ) : (
        <StatsBody stats={stats} comparison={comparison} />
      )}
    </div>
  )
}

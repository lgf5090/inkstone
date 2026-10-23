/**
 * The statistics screen: one range of the account's finished and filed work.
 *
 * The screen is a thin reading of `GET /api/todos/stats`. It never derives a number from the tasks it
 * happens to hold — the server measures in the account's own days, and a second implementation here
 * would disagree the moment a page is incomplete or a zone changes. What the browser decides is only
 * the range: the presets and the bucket are calendar arithmetic on the day strings the answer echoes,
 * and every move is written into the address so a reload or the back button opens the same question.
 *
 * The page is read in one order: the trend answers "what happened", the four headline numbers answer
 * "how much", the heatmap answers "when", the breakdowns answer "where", and the backlog answers
 * "what is left". Comparison against the previous window is a chip on each headline number rather than
 * a section of its own — the same fact, one row closer to the number it describes.
 */
import { useEffect, useMemo } from 'react'
import { Download } from 'lucide-react'
import { localDate } from '@shared/assistant-time'
import type { TaskStatsBucket, TaskStatsNamedCount, TodoStats } from '@shared/todos/model'
import { Button, IconButton } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Segmented } from '../../components/form'
import { Tooltip } from '../../components/overlay'
import { localeTag, t, type MessageKey } from '../../lib/i18n'
import { useSession } from '../../store/session'
import { shiftDay } from './due-range'
import {
  countDeltaPercent,
  rangeLengthDays,
  rateDeltaPoints,
  usePreviousStats,
  type PreviousStats,
} from './stats-compare'
import { downloadStatsCsv } from './stats-csv'
import { PRIORITIES, listName, tagName, weekdayName } from './stats-format'
import { priorityLabel } from './todo-ui'
import { useTodos } from './store'
import {
  DeltaChip,
  Donut,
  FlowChart,
  SliceBars,
  Sparkline,
  StackedBar,
  TrendChart,
  WeekHourHeatmap,
  durationLabel,
  type StatSlice,
} from './stats-charts'
import { WorklogSection } from './WorklogSection'

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

/** How many slices a breakdown shows before the rest are folded into one row. */
const SLICE_LIMIT = 6

/** The colour a priority slice is painted: the same ladder the task card's dot uses. */
const PRIORITY_COLORS: Record<string, string> = {
  low: 'var(--text-quaternary)',
  medium: 'var(--accent)',
  high: 'var(--warning)',
  urgent: 'var(--danger)',
}

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

function percent(rate: number): string {
  return new Intl.NumberFormat(localeTag(), { style: 'percent', maximumFractionDigits: 0 }).format(rate)
}

/** The first `limit` slices, with everything past them folded into one "other" row. */
function foldSlices(slices: StatSlice[], limit = SLICE_LIMIT): StatSlice[] {
  if (slices.length <= limit) return slices
  const head = slices.slice(0, limit - 1)
  const rest = slices.slice(limit - 1)
  return [...head, {
    key: 'other',
    label: t('todo.stats.other_slices', { count: rest.length }),
    value: rest.reduce((sum, slice) => sum + slice.value, 0),
    color: 'var(--text-quaternary)',
  }]
}

/** A card: a heading, an optional hint, and whatever the section draws. */
function Card({ title, hint, action, children, className }: {
  title: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4 ${className ?? ''}`}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{title}</h2>
        {action}
      </div>
      {hint && <p className="mb-2 text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{hint}</p>}
      {children}
    </section>
  )
}

/**
 * The five numbers the screen is about.
 *
 * Each carries its own change against the equally long window before it, and the two that have a
 * shape — completed and created — carry a sparkline of the same series the trend draws. A window that
 * held nothing prints a dash rather than an infinity dressed up as a percentage.
 *
 * The two rates sit next to each other on purpose (D10): the completion rate counts finished over
 * finished-plus-owed and leaves the abandonments out of both halves, so the sentence is only honest
 * when the reader can see what was left out beside it. `DefinitionsTable` spells all three rules for a
 * screen reader, because a label like "completion rate" carries its whole meaning in its denominator.
 */
function HeadlineStats({ stats, comparison }: { stats: TodoStats; comparison: PreviousStats }) {
  const { summary, series } = stats
  const previous = comparison.status === 'ready' ? comparison.stats : null
  // Each delta is decided here rather than inside the JSX, so the null case is one branch instead of
  // three ternaries that a reader has to prove equal.
  const completedDelta = previous === null ? null : countDeltaPercent(summary.completed, previous.summary.completed)
  const createdDelta = previous === null ? null : countDeltaPercent(summary.created, previous.summary.created)
  const completionDelta = previous !== null && previous.summary.completed > 0
    ? rateDeltaPoints(summary.completionRate, previous.summary.completionRate, previous.summary.completed + previous.summary.open)
    : null
  const abandonedDelta = previous !== null && previous.summary.abandoned > 0
    ? rateDeltaPoints(
      summary.abandonedRate,
      previous.summary.abandonedRate,
      previous.summary.completed + previous.summary.abandoned + previous.summary.open,
    )
    : null
  const onTimeDelta = previous === null
    ? null
    : rateDeltaPoints(summary.onTimeRate, previous.summary.onTimeRate, previous.summary.onTimeDue)
  return (
    <div className="flex flex-col gap-2">
    {/* Five across from `md` up: the two rates have to read as one pair, and a grid that left the
        fifth card alone on a second row would not say that. Below `md` the cards stay two across and
        wrap, which is the shape the narrowest window already handles. */}
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      <KpiCard
        id="completed"
        label={t('todo.stats.completed')}
        value={integer(summary.completed)}
        delta={completedDelta}
        sparkline={series.map((point) => point.completed)}
        tone="var(--accent)"
      />
      <KpiCard
        id="created"
        label={t('todo.stats.created')}
        value={integer(summary.created)}
        delta={createdDelta}
        sparkline={series.map((point) => point.created)}
        tone="var(--text-tertiary)"
      />
      <KpiCard
        id="completion_rate"
        label={t('todo.stats.completion_rate')}
        value={percent(summary.completionRate)}
        hint={t('todo.stats.completion_rate_hint', { completed: summary.completed, open: summary.open })}
        delta={completionDelta}
        points
      />
      <KpiCard
        id="abandoned_rate"
        label={t('todo.stats.abandoned_rate')}
        value={percent(summary.abandonedRate)}
        hint={t('todo.stats.abandoned_rate_hint', {
          abandoned: summary.abandoned,
          total: summary.completed + summary.abandoned + summary.open,
        })}
        delta={abandonedDelta}
        points
      />
      <KpiCard
        id="on_time"
        label={t('todo.stats.on_time')}
        value={summary.onTimeDue === 0 ? '—' : percent(summary.onTimeRate)}
        hint={t('todo.stats.on_time_hint', { onTime: summary.onTime, due: summary.onTimeDue })}
        delta={onTimeDelta}
        points
      />
    </div>
    <DefinitionsTable />
    {comparison.status === 'loading' && (
      <p role="status" className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
        {t('todo.stats.compare.loading')}
      </p>
    )}
    {comparison.status === 'unavailable' && (
      <p role="status" className="text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">
        {t('todo.stats.compare.unavailable')}
        {comparison.error ? ` · ${comparison.error}` : ''}
        {' · '}
        {t('todo.stats.compare.unavailable_hint')}
      </p>
    )}
    </div>
  )
}

function KpiCard({ id, label, value, hint, delta, sparkline, tone, points }: {
  id: string
  label: string
  value: string
  hint?: string
  delta: number | null
  sparkline?: readonly number[]
  tone?: string
  points?: boolean
}) {
  return (
    <div data-stats-kpi={id} className="flex min-w-0 flex-col gap-1 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      {/* Wraps rather than truncates: two cards across a phone leave the label and a points chip
          fighting for one line, and a half-cut label is not a label. */}
      <div className="flex flex-wrap items-start justify-between gap-x-1 gap-y-0.5">
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
        <DeltaChip id={id} value={delta} points={points} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="text-[length:var(--text-22)] leading-none font-semibold tabular text-[var(--text-primary)]">{value}</span>
        {sparkline && sparkline.length > 1 && <Sparkline values={sparkline} tone={tone} />}
      </div>
      {hint && <span className="text-[length:var(--text-10-5)] leading-snug text-[var(--text-quaternary)]">{hint}</span>}
    </div>
  )
}

/** The small readings that are not worth a card each: one row of four. */
function SecondaryStats({ stats }: { stats: TodoStats }) {
  const { summary, leadTime } = stats
  const rows = [
    { id: 'median_lead', label: t('todo.stats.median_lead'), value: durationLabel(summary.medianLeadTimeMs), hint: t('todo.stats.median_lead_hint', { value: durationLabel(leadTime.p90) }) },
    { id: 'streak', label: t('todo.stats.streak'), value: t('todo.stats.days', { value: summary.currentStreak }), hint: t('todo.stats.streak_hint', { days: summary.longestStreak }) },
    { id: 'overdue', label: t('todo.stats.overdue'), value: integer(summary.overdue), hint: t('todo.stats.overdue_hint') },
    { id: 'net', label: t('todo.stats.net'), value: `${summary.net > 0 ? '+' : ''}${integer(summary.net)}`, hint: t('todo.stats.net_hint') },
  ]
  return (
    <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
      {rows.map((row) => (
        <div key={row.id} data-stats-secondary={row.id} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2">
          <dt className="truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{row.label}</dt>
          <dd className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{row.value}</dd>
          <dd className="truncate text-[length:var(--text-10)] text-[var(--text-quaternary)]">{row.hint}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A named distribution as slices: the list's own colour, or the priority ladder's. */
function namedSlices(
  rows: readonly TaskStatsNamedCount[],
  colors: ReadonlyMap<string, string>,
  nameOf: (row: TaskStatsNamedCount) => string,
): StatSlice[] {
  return rows
    .filter((row) => row.completed > 0)
    .map((row) => ({
      key: row.id ?? `name:${row.name ?? ''}`,
      label: nameOf(row),
      value: row.completed,
      color: (row.id ? colors.get(row.id) : null) ?? 'var(--accent)',
    }))
}

function Breakdowns({ stats }: { stats: TodoStats }) {
  const { distributions, summary } = stats
  const lists = useTodos((state) => state.lists)
  const tags = useTodos((state) => state.tags)
  const listColors = useMemo(() => new Map(lists.map((list) => [list.id, list.color ?? 'var(--accent)'])), [lists])
  const tagColors = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.color ?? 'var(--accent)'])), [tags])

  const prioritySlices: StatSlice[] = PRIORITIES.map((priority) => {
    const row = distributions.byPriority.find((entry) => entry.priority === priority)
    return {
      key: priority,
      label: priorityLabel(priority),
      value: row?.completed ?? 0,
      color: PRIORITY_COLORS[priority] ?? 'var(--accent)',
    }
  })

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title={t('todo.stats.by_list')} hint={t('todo.stats.by_list_hint')}>
        <SliceBars label={t('todo.stats.by_list')} slices={foldSlices(namedSlices(distributions.byList, listColors, listName))} />
      </Card>
      <Card title={t('todo.stats.by_priority')}>
        <Donut slices={prioritySlices} caption={t('todo.stats.by_priority')} />
      </Card>
      <Card title={t('todo.stats.by_tag')} hint={t('todo.stats.by_tag_hint')}>
        <SliceBars label={t('todo.stats.by_tag')} slices={foldSlices(namedSlices(distributions.byTag, tagColors, tagName))} />
      </Card>
      <Card
        title={t('todo.stats.by_weekday')}
        action={<span className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">{t('todo.stats.weekday_total', { count: summary.completed })}</span>}
      >
        <SliceBars
          label={t('todo.stats.by_weekday')}
          slices={distributions.byWeekday.map((entry) => ({
            key: String(entry.weekday),
            label: weekdayName(entry.weekday),
            value: entry.completed,
            color: 'var(--accent)',
          }))}
        />
      </Card>
    </div>
  )
}

function Backlog({ stats }: { stats: TodoStats }) {
  const { backlog } = stats
  const slices: StatSlice[] = [
    { key: 'under7', label: t('todo.stats.backlog.under7'), value: backlog.under7, color: 'var(--accent)' },
    { key: 'days7to30', label: t('todo.stats.backlog.7to30'), value: backlog.days7to30, color: 'var(--warning)' },
    { key: 'over30', label: t('todo.stats.backlog.over30'), value: backlog.over30, color: 'var(--danger)' },
    { key: 'none', label: t('todo.stats.backlog.none'), value: backlog.none, color: 'var(--text-quaternary)' },
  ]
  return (
    <Card title={t('todo.stats.backlog.title')} hint={t('todo.stats.backlog.hint')}>
      <StackedBar label={t('todo.stats.backlog.title')} slices={slices} />
    </Card>
  )
}

/** The two goals the account saved, already folded to null for "off" by the settings merge. */
interface TodoGoals {
  daily: number | null
  weekly: number | null
}

/** A pace printed to one decimal — the same number the verdict is measured on. */
function goalPace(value: number): number {
  return Math.round(value * 10) / 10
}

/** One saved goal against the pace the range averaged, with the verdict spelled out beside it. */
function GoalRow({ id, label, pace, goal, format }: {
  id: 'daily' | 'weekly'
  label: string
  pace: number
  goal: number
  format: (value: number) => string
}) {
  const reached = pace >= goal
  return (
    <div data-stats-goal={id} data-stats-goal-state={reached ? 'reached' : 'missed'} className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</span>
      <span className="text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">
        {t('todo.stats.goal.against', { done: format(pace), goal: format(goal) })}
      </span>
      <span className="flex items-center gap-1 text-[length:var(--text-10-5)] tabular text-[var(--text-tertiary)]">
        <span className={reached ? 'text-[var(--success)]' : 'text-[var(--warning)]'} data-stats-goal-check={reached ? '' : undefined} aria-hidden="true">{reached ? '●' : '○'}</span>
        {reached ? t('todo.stats.goal.reached') : t('todo.stats.goal.short', { value: format(goalPace(goal - pace)) })}
      </span>
    </div>
  )
}

/**
 * The daily and weekly goals the reader saved, measured against the range's own pace.
 *
 * The block exists only while a goal does: a section that said "no goal" in three places would take
 * space from the numbers the screen is actually about.
 */
function GoalReference({ stats, goals }: { stats: TodoStats; goals: TodoGoals }) {
  const { daily, weekly } = goals
  if (daily === null && weekly === null) return null
  const days = rangeLengthDays(stats.range)
  const perDay = goalPace(stats.summary.completed / days)
  const perWeek = goalPace((stats.summary.completed / days) * 7)
  return (
    <section data-stats-goal="" className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 md:p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-secondary)]">{t('todo.stats.goal.title')}</h2>
        <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('todo.stats.goal.hint')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {daily !== null && (
          <GoalRow id="daily" label={t('todo.stats.goal.daily')} pace={perDay} goal={daily}
            format={(value) => t('todo.stats.goal.per_day', { value: String(value) })} />
        )}
        {weekly !== null && (
          <GoalRow id="weekly" label={t('todo.stats.goal.weekly')} pace={perWeek} goal={weekly}
            format={(value) => t('todo.stats.goal.per_week', { value: String(value) })} />
        )}
      </div>
    </section>
  )
}

/**
 * The three counting rules, as data rather than as prose.
 *
 * A rate's whole meaning lives in its denominator, and the denominator of the first one is the thing a
 * reader cannot see from the label: `completionRate` deliberately does not count the tasks the reader
 * gave up, because the number was published before that state existed and moving it under their feet
 * would read as a drop they had caused. The screen says so out loud beside the two cards (their hints)
 * and again here, where a screen reader gets the same three definitions the worker's own header states
 * (plan §5 D10) rather than a picture of a bar.
 */
function DefinitionsTable() {
  const rows = [
    { id: 'completion_rate', label: t('todo.stats.completion_rate'), definition: t('todo.stats.definitions.completion_rate') },
    { id: 'abandoned_rate', label: t('todo.stats.abandoned_rate'), definition: t('todo.stats.definitions.abandoned_rate') },
    { id: 'finished_only', label: t('todo.stats.definitions.finished_only_label'), definition: t('todo.stats.definitions.finished_only') },
  ]
  return (
    <table className="sr-only" data-stats-definitions="">
      <caption>{t('todo.stats.definitions.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('todo.stats.definitions.column.metric')}</th>
          <th scope="col">{t('todo.stats.definitions.column.definition')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">{row.label}</th>
            <td>{row.definition}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The hidden table behind the trend, so the picture is also readable as numbers. */
function SeriesTable({ stats }: { stats: TodoStats }) {
  return (
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
        {stats.series.map((point) => (
          <tr key={point.day}>
            <th scope="row">{point.day}</th>
            <td>{point.completed}</td>
            <td>{point.created}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The hidden table behind the flow, so the bands are also readable as numbers. */
function FlowTable({ stats }: { stats: TodoStats }) {
  return (
    <table className="sr-only" data-stats-flow="">
      <caption>{t('todo.stats.flow.table_caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('todo.stats.trend.column.period')}</th>
          <th scope="col">{t('todo.stats.flow.todo')}</th>
          <th scope="col">{t('todo.stats.flow.in_progress')}</th>
          <th scope="col">{t('todo.stats.flow.done')}</th>
        </tr>
      </thead>
      <tbody>
        {stats.flow.map((point) => (
          <tr key={point.day}>
            <th scope="row">{point.day}</th>
            <td>{point.todo}</td>
            <td>{point.inProgress}</td>
            <td>{point.done}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatsBody({ stats, comparison, goals }: { stats: TodoStats; comparison: PreviousStats; goals: TodoGoals }) {
  // A range that never held any work has no stock to draw; the card is absent rather than empty.
  const hasFlow = stats.flow.some((point) => point.todo + point.inProgress + point.done > 0)
  return (
    <div className="flex flex-col gap-4">
      <HeadlineStats stats={stats} comparison={comparison} />
      <SecondaryStats stats={stats} />
      <Card
        title={t('todo.stats.trend.title')}
        action={(
          <span className="text-[length:var(--text-10-5)] tabular text-[var(--text-quaternary)]">
            {t('todo.stats.completed')} {integer(stats.summary.completed)} · {t('todo.stats.created')} {integer(stats.summary.created)}
          </span>
        )}
      >
        <TrendChart
          series={stats.series}
          bucket={stats.range.bucket}
          goal={stats.range.bucket === 'day' ? goals.daily : null}
          from={stats.range.from}
          to={stats.range.to}
        />
        <SeriesTable stats={stats} />
      </Card>
      {hasFlow && (
        <Card title={t('todo.stats.flow.title')} hint={t('todo.stats.flow.hint')}>
          <FlowChart
            flow={stats.flow}
            bucket={stats.range.bucket}
            trackedSince={stats.flowTrackedSince}
            from={stats.range.from}
            to={stats.range.to}
          />
          <FlowTable stats={stats} />
        </Card>
      )}
      <Card
        title={t('todo.stats.heatmap.title')}
        hint={t('todo.stats.heatmap.hint')}
      >
        <WeekHourHeatmap cells={stats.distributions.byWeekdayHour} />
      </Card>
      <Breakdowns stats={stats} />
      <Backlog stats={stats} />
      <GoalReference stats={stats} goals={goals} />
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
 * The range, the bucket and the export.
 *
 * One row on a wide window, one scrolling row on a phone: the two segmented controls keep their height
 * rather than wrapping into a block, and the export is an icon so the row does not grow a third line.
 */
function StatsToolbar({ stats, onRange, onBucket, onExport }: {
  stats: TodoStats
  onRange: (choice: RangeChoice) => void
  onBucket: (bucket: TaskStatsBucket) => void
  onExport: () => void
}) {
  const today = localDate(Date.now(), stats.range.timezone)
  const preset = presetOf(stats.range, today)
  const empty = stats.summary.completed === 0 && stats.summary.created === 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto">
        <Segmented<RangeChoice | 'custom'>
          label={t('todo.stats.range.label')}
          value={preset ?? 'custom'}
          options={RANGE_CHOICES.map((choice) => ({ value: choice.value, label: t(choice.labelKey) }))}
          onChange={(value) => { if (value !== 'custom') onRange(value) }}
          className="shrink-0 [&_button]:min-h-9"
        />
        <Segmented<TaskStatsBucket>
          label={t('todo.stats.bucket.label')}
          value={stats.range.bucket}
          options={BUCKETS.map((bucket) => ({ value: bucket, label: t(BUCKET_LABELS[bucket]) }))}
          onChange={onBucket}
          className="shrink-0 [&_button]:min-h-9"
        />
        <span className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <Tooltip label={empty ? t('todo.stats.export.empty') : t('todo.stats.export.label')}>
            <IconButton label={t('todo.stats.export.label')} size="sm" className="size-9" disabled={empty} onClick={onExport}>
              <Download size={14} />
            </IconButton>
          </Tooltip>
        </span>
      </div>
      <p className="text-[length:var(--text-10-5)] leading-relaxed tabular-nums text-[var(--text-quaternary)]">
        {stats.range.from} – {stats.range.to}
        {preset === null ? ` · ${t('todo.stats.range.custom')}` : ''}
        {' · '}
        {t('todo.stats.timezone_note', { zone: stats.range.timezone })}
      </p>
      {empty && (
        <p className="text-[length:var(--text-10-5)] text-[var(--warning)]">{t('todo.stats.export.empty')}</p>
      )}
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
  const dailyGoal = useSession((state) => state.settings.todo.dailyGoal) ?? null
  const weeklyGoal = useSession((state) => state.settings.todo.weeklyGoal) ?? null

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

  const pickBucket = (next: TaskStatsBucket): void => {
    if (!stats) return
    setStatsRange({ from: stats.range.from, to: stats.range.to, bucket: next })
  }

  return (
    <div
      data-stats-view=""
      aria-busy={status === 'loading' || undefined}
      className="mx-auto flex w-full max-w-[1080px] flex-col gap-4 px-3 pb-10 pt-3 md:px-6"
    >
      {stats && (
        <StatsToolbar
          stats={stats}
          onRange={pickRange}
          onBucket={pickBucket}
          onExport={() => { downloadStatsCsv(stats) }}
        />
      )}
      {status === 'error' ? (
        <StatsError error={error} onRetry={() => { void loadStats() }} />
      ) : !stats ? (
        <LoadingBlock label={t('todo.stats.loading')} />
      ) : stats.summary.completed === 0 && stats.summary.created === 0 ? (
        <Empty title={t('todo.stats.empty')} description={t('todo.stats.empty_hint')} />
      ) : (
        <>
          <StatsBody stats={stats} comparison={comparison} goals={{ daily: dailyGoal, weekly: weeklyGoal }} />
          {/* The hours the ledger holds, beside the counts the plate moved: the two read different
              tables and are allowed to disagree about the same week. */}
          <WorklogSection from={stats.range.from} to={stats.range.to} />
        </>
      )}
    </div>
  )
}

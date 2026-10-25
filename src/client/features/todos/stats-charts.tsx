/**
 * The marks the statistics screen draws.
 *
 * Every one of them is inline SVG or a CSS grid rather than a charting dependency: six small figures
 * over at most ninety points is less work than a library's setup, and hand-drawn marks can carry an
 * `aria-label`, a real table beside them, and the app's own tokens. Colour is never the only
 * distinction — each figure is labelled, and the trend also names its series in a legend.
 */
import { useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { localeTag, t } from '../../lib/i18n'
import { narrowWeekdayLabel } from '../../lib/time'
import type {
  TaskStatsBucket,
  TaskStatsFlowPoint,
  TaskStatsPoint,
  TaskStatsWeekdayHourCount,
} from '@shared/todos/model'

const MINUTE_MS = 60_000

/** One slice of a donut or a stacked bar: a name, a count and the colour it is painted. */
export interface StatSlice {
  key: string
  label: string
  value: number
  color: string
  /**
   * The words this slice's number means, for a caller whose unit is not a count.
   *
   * A bar's share is a number either way, but `0.1` beside a list's name only reads as time because the
   * reader happens to know the block counts hours. A caller that knows the unit says it; a caller that
   * counts tasks, which is most of them, leaves this out and gets the number.
   */
  display?: string
}

function percent(share: number): string {
  return new Intl.NumberFormat(localeTag(), { style: 'percent', maximumFractionDigits: 0 }).format(share)
}

function tickLabel(day: string, bucket: TaskStatsBucket): string {
  const date = new Date(`${day}T00:00:00`)
  if (bucket === 'month') return new Intl.DateTimeFormat(localeTag(), { year: '2-digit', month: 'short' }).format(date)
  return new Intl.DateTimeFormat(localeTag(), { month: 'numeric', day: 'numeric' }).format(date)
}

/**
 * The completed-versus-created trend.
 *
 * The area under the completed line is what makes a shape readable at a glance; the created line is
 * dashed and named in the legend so the two are never told apart by colour alone. Hovering (or moving a
 * finger across) the plot pins the nearest bucket and prints its numbers — the same reading the hidden
 * table gives a screen reader.
 */
export function TrendChart({ series, bucket, goal, from, to }: {
  series: readonly TaskStatsPoint[]
  bucket: TaskStatsBucket
  /** A per-bucket reference line, or null when the account has no goal. */
  goal: number | null
  /** The range the answer describes; the chart's accessible name states it, not the first bucket. */
  from: string
  to: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState<{ completed: boolean; created: boolean }>({ completed: false, created: false })
  const wrap = useRef<HTMLDivElement>(null)
  const width = 640
  const height = 180
  const padX = 6
  const padTop = 10
  const plotWidth = width - padX * 2
  const plotHeight = height - padTop
  const max = Math.max(1, goal ?? 0, ...series.flatMap((point) => [point.completed, point.created]))
  const x = (index: number): number => (series.length <= 1 ? padX + plotWidth / 2 : padX + (index / (series.length - 1)) * plotWidth)
  const y = (value: number): number => padTop + plotHeight - (value / max) * plotHeight
  const points = (key: 'completed' | 'created'): string => series
    .map((point, index) => `${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`)
    .join(' ')
  const ticks = series.length > 1
    ? [...new Set([0, Math.floor((series.length - 1) / 3), Math.floor(((series.length - 1) * 2) / 3), series.length - 1])]
    : [0]
  const hovered = hover !== null ? series[hover] : null
  const half = max / 2

  const onMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || series.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setHover(Math.round(ratio * (series.length - 1)))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LegendToggle label={t('todo.stats.completed')} color="var(--accent)" hidden={hidden.completed}
          onToggle={() => setHidden((state) => ({ ...state, completed: !state.completed }))} />
        <LegendToggle label={t('todo.stats.created')} color="var(--text-tertiary)" dashed hidden={hidden.created}
          onToggle={() => setHidden((state) => ({ ...state, created: !state.created }))} />
        {goal !== null && <LegendToggle label={t('todo.stats.goal.line')} color="var(--text-quaternary)" dashed hidden={false} />}
      </div>
      <div className="flex gap-2">
        <div className="flex h-44 shrink-0 flex-col justify-between pb-1 text-right text-[length:var(--text-9)] tabular leading-none text-[var(--text-quaternary)]" aria-hidden="true">
          <span>{max}</span>
          <span>{Number.isInteger(half) ? half : half.toFixed(1)}</span>
          <span>{String(0)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            ref={wrap}
            className="relative touch-pan-y"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <svg
              role="img"
              aria-label={t('todo.stats.trend.chart_label', { from, to, completed: series.reduce((sum, point) => sum + point.completed, 0), created: series.reduce((sum, point) => sum + point.created, 0) })}
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="h-44 w-full"
            >
              <defs>
                <linearGradient id="todo-stats-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                <line
                  key={ratio}
                  x1={padX}
                  y1={padTop + plotHeight * ratio}
                  x2={width - padX}
                  y2={padTop + plotHeight * ratio}
                  stroke="var(--border-subtle)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {!hidden.completed && series.length > 1 && (
                <polygon
                  points={`${x(0)},${height - 1} ${points('completed')} ${x(series.length - 1)},${height - 1}`}
                  fill="url(#todo-stats-area)"
                />
              )}
              {!hidden.completed && (
                <polyline
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  points={points('completed')}
                />
              )}
              {!hidden.created && (
                <polyline
                  fill="none"
                  stroke="var(--text-tertiary)"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                  points={points('created')}
                />
              )}
              {goal !== null && (
                <line
                  x1={padX}
                  y1={y(goal)}
                  x2={width - padX}
                  y2={y(goal)}
                  stroke="var(--text-quaternary)"
                  strokeWidth="1"
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {series.length === 1 && !hidden.completed && (
                <circle cx={x(0)} cy={y(series[0]!.completed)} r="2.5" fill="var(--accent)" />
              )}
              {hovered && hover !== null && (
                <>
                  <line
                    x1={x(hover)}
                    y1={padTop}
                    x2={x(hover)}
                    y2={height}
                    stroke="var(--border-strong)"
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  {!hidden.completed && <circle cx={x(hover)} cy={y(hovered.completed)} r="3" fill="var(--accent)" stroke="var(--bg-surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
                  {!hidden.created && <circle cx={x(hover)} cy={y(hovered.created)} r="2.5" fill="var(--text-tertiary)" stroke="var(--bg-surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
                </>
              )}
            </svg>
            {hovered && hover !== null && (
              <div
                role="status"
                className="pointer-events-none absolute top-1 z-[var(--z-pop)] -translate-x-1/2 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 text-[length:var(--text-10-5)] leading-tight whitespace-nowrap shadow-[var(--shadow-pop)]"
                style={{ left: `${Math.min(88, Math.max(12, (x(hover) / width) * 100))}%` }}
              >
                <div className="font-medium text-[var(--text-primary)]">{tickLabel(hovered.day, bucket)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 tabular text-[var(--text-tertiary)]">
                  <span className="size-1.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                  {t('todo.stats.completed')} {hovered.completed}
                </div>
                <div className="flex items-center gap-1.5 tabular text-[var(--text-tertiary)]">
                  <span className="size-1.5 rounded-full bg-[var(--text-tertiary)]" aria-hidden="true" />
                  {t('todo.stats.created')} {hovered.created}
                </div>
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[length:var(--text-9)] tabular leading-none text-[var(--text-quaternary)]" aria-hidden="true">
            {ticks.map((index) => <span key={index}>{tickLabel(series[index]!.day, bucket)}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The cumulative flow: how much work stood in each status at the end of every bucket.
 *
 * The bands stack from the bottom up in the order a task moves — done, in progress, to do — so the
 * height of the whole stack is the work that existed, and a band's thickness is its share. Colour is
 * not the only distinction: every band is named in the legend and repeated in the hidden table, and a
 * band can be switched off to read the other two. `trackedSince` is a dashed vertical line because
 * before that day the in-progress band is an approximation, not a record.
 */
export function FlowChart({ flow, bucket, trackedSince, from, to }: {
  flow: readonly TaskStatsFlowPoint[]
  bucket: TaskStatsBucket
  trackedSince: string | null
  /** The range the answer describes; the chart's accessible name states it, not the first bucket. */
  from: string
  to: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const [hidden, setHidden] = useState({ todo: false, inProgress: false, done: false })
  const wrap = useRef<HTMLDivElement>(null)
  const width = 640
  const height = 180
  const padX = 6
  const padTop = 10
  const plotWidth = width - padX * 2
  const plotHeight = height - padTop
  const max = Math.max(1, ...flow.map((point) => point.todo + point.inProgress + point.done))
  const x = (index: number): number => (flow.length <= 1 ? padX + plotWidth / 2 : padX + (index / (flow.length - 1)) * plotWidth)
  const y = (value: number): number => padTop + plotHeight - (value / max) * plotHeight

  // Bottom-up, so hiding one band closes the gap rather than leaving a hole in the stack.
  const order = [
    { key: 'done' as const, color: 'var(--accent)', values: flow.map((point) => point.done) },
    { key: 'inProgress' as const, color: 'var(--warning)', values: flow.map((point) => point.inProgress) },
    { key: 'todo' as const, color: 'var(--text-tertiary)', values: flow.map((point) => point.todo) },
  ]
  const bands: Array<{ key: string; color: string; lower: number[]; upper: number[] }> = []
  let lower = flow.map(() => 0)
  for (const entry of order) {
    if (hidden[entry.key]) continue
    const upper = lower.map((value, index) => value + entry.values[index]!)
    bands.push({ key: entry.key, color: entry.color, lower, upper })
    lower = upper
  }

  const bandPoints = (band: { lower: number[]; upper: number[] }): string => {
    if (flow.length === 1) {
      // One bucket has no width between two x positions; the band becomes the plot's full width.
      const left = padX
      const right = width - padX
      return `${left},${y(band.upper[0]!).toFixed(1)} ${right},${y(band.upper[0]!).toFixed(1)} `
        + `${right},${y(band.lower[0]!).toFixed(1)} ${left},${y(band.lower[0]!).toFixed(1)}`
    }
    const top = flow.map((_, index) => `${x(index).toFixed(1)},${y(band.upper[index]!).toFixed(1)}`)
    const bottom = flow.map((_, index) => `${x(index).toFixed(1)},${y(band.lower[index]!).toFixed(1)}`).reverse()
    return [...top, ...bottom].join(' ')
  }

  const ticks = flow.length > 1
    ? [...new Set([0, Math.floor((flow.length - 1) / 3), Math.floor(((flow.length - 1) * 2) / 3), flow.length - 1])]
    : [0]
  const hovered = hover !== null ? flow[hover] : null
  const half = max / 2
  // The bucket the tracked day falls in; a day past the last start still reads on the last bucket.
  const trackedIndex = trackedSince === null
    ? -1
    : flow.reduce((found, point, index) => (point.day <= trackedSince ? index : found), -1)
  const last = flow[flow.length - 1]

  const onMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = wrap.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || flow.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setHover(Math.round(ratio * (flow.length - 1)))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <LegendToggle label={t('todo.stats.flow.todo')} color="var(--text-tertiary)" hidden={hidden.todo}
          onToggle={() => setHidden((state) => ({ ...state, todo: !state.todo }))} />
        <LegendToggle label={t('todo.stats.flow.in_progress')} color="var(--warning)" hidden={hidden.inProgress}
          onToggle={() => setHidden((state) => ({ ...state, inProgress: !state.inProgress }))} />
        <LegendToggle label={t('todo.stats.flow.done')} color="var(--accent)" hidden={hidden.done}
          onToggle={() => setHidden((state) => ({ ...state, done: !state.done }))} />
        {trackedIndex >= 0 && (
          <LegendToggle label={t('todo.stats.flow.tracked_since')} color="var(--text-quaternary)" dashed hidden={false} />
        )}
      </div>
      <div className="flex gap-2">
        <div className="flex h-44 shrink-0 flex-col justify-between pb-1 text-right text-[length:var(--text-9)] tabular leading-none text-[var(--text-quaternary)]" aria-hidden="true">
          <span>{max}</span>
          <span>{Number.isInteger(half) ? half : half.toFixed(1)}</span>
          <span>{String(0)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            ref={wrap}
            className="relative touch-pan-y"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <svg
              role="img"
              aria-label={t('todo.stats.flow.chart_label', {
                from,
                to,
                todo: last?.todo ?? 0,
                inProgress: last?.inProgress ?? 0,
                done: last?.done ?? 0,
              })}
              viewBox={`0 0 ${width} ${height}`}
              preserveAspectRatio="none"
              className="h-44 w-full"
            >
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                <line
                  key={ratio}
                  x1={padX}
                  y1={padTop + plotHeight * ratio}
                  x2={width - padX}
                  y2={padTop + plotHeight * ratio}
                  stroke="var(--border-subtle)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {bands.map((band) => (
                <polygon key={band.key} points={bandPoints(band)} fill={band.color} fillOpacity="0.8" />
              ))}
              {trackedIndex >= 0 && (
                <line
                  x1={x(trackedIndex)}
                  y1={padTop}
                  x2={x(trackedIndex)}
                  y2={height}
                  stroke="var(--text-quaternary)"
                  strokeWidth="1"
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {hovered && hover !== null && (
                <line
                  x1={x(hover)}
                  y1={padTop}
                  x2={x(hover)}
                  y2={height}
                  stroke="var(--border-strong)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {hovered && hover !== null && (
              <div
                role="status"
                className="pointer-events-none absolute top-1 z-[var(--z-pop)] -translate-x-1/2 rounded-[var(--r-sm)] border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 text-[length:var(--text-10-5)] leading-tight whitespace-nowrap shadow-[var(--shadow-pop)]"
                style={{ left: `${Math.min(88, Math.max(12, (x(hover) / width) * 100))}%` }}
              >
                <div className="font-medium text-[var(--text-primary)]">{tickLabel(hovered.day, bucket)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 tabular text-[var(--text-tertiary)]">
                  <span className="size-1.5 rounded-full bg-[var(--text-tertiary)]" aria-hidden="true" />
                  {t('todo.stats.flow.todo')} {hovered.todo}
                </div>
                <div className="flex items-center gap-1.5 tabular text-[var(--text-tertiary)]">
                  <span className="size-1.5 rounded-full bg-[var(--warning)]" aria-hidden="true" />
                  {t('todo.stats.flow.in_progress')} {hovered.inProgress}
                </div>
                <div className="flex items-center gap-1.5 tabular text-[var(--text-tertiary)]">
                  <span className="size-1.5 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                  {t('todo.stats.flow.done')} {hovered.done}
                </div>
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[length:var(--text-9)] tabular leading-none text-[var(--text-quaternary)]" aria-hidden="true">
            {ticks.map((index) => <span key={index}>{tickLabel(flow[index]!.day, bucket)}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}

function LegendToggle({ label, color, dashed, hidden, onToggle }: {
  label: string
  color: string
  dashed?: boolean
  hidden: boolean
  onToggle?: () => void
}) {
  const mark = (
    <span className={cn('inline-flex items-center gap-1.5 text-[length:var(--text-11)]', hidden ? 'text-[var(--text-quaternary)] line-through' : 'text-[var(--text-tertiary)]')}>
      <svg aria-hidden="true" width="16" height="6" viewBox="0 0 16 6">
        <line x1="0" y1="3" x2="16" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 3' : undefined} />
      </svg>
      {label}
    </span>
  )
  if (!onToggle) return mark
  return (
    <button type="button" aria-pressed={!hidden} onClick={onToggle} className="min-h-6 rounded-[var(--r-xs)] px-0.5 hover:bg-[var(--bg-hover)]">
      {mark}
    </button>
  )
}

/** A tiny shape behind a KPI: the same series the trend draws, without axes. */
export function Sparkline({ values, tone = 'var(--accent)' }: { values: readonly number[]; tone?: string }) {
  if (values.length < 2) return null
  const max = Math.max(1, ...values)
  const width = 88
  const height = 24
  const points = values
    .map((value, index) => `${((index / (values.length - 1)) * width).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ')
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-6 w-[88px]">
      <polyline fill="none" stroke={tone} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={points} opacity="0.85" />
    </svg>
  )
}

/**
 * A change against the previous window, as a pill.
 *
 * The arrow carries the direction as a glyph (an SVG, so it adds nothing to the text a test or a screen
 * reader reads) and the colour reinforces it. `null` is a window with nothing to divide by, which is a
 * dash rather than a fake zero.
 */
export function DeltaChip({ id, value, points = false }: { id?: string; value: number | null; points?: boolean }) {
  if (value === null) {
    return <span data-stats-delta={id} className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">—</span>
  }
  // A count is compared in whole percents; a rate in points, where one decimal is still meaningful.
  const rounded = points ? Math.round(value * 10) / 10 : Math.round(value)
  const signed = `${rounded > 0 ? '+' : rounded < 0 ? '-' : ''}${Math.abs(rounded)}`
  const tone = rounded > 0 ? 'text-[var(--success)]' : rounded < 0 ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]'
  return (
    <span
      data-stats-delta={id}
      className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[length:var(--text-10-5)] tabular font-medium', tone)}
      style={rounded === 0 ? undefined : { backgroundColor: 'color-mix(in oklab, currentColor 10%, transparent)' }}
    >
      {rounded !== 0 && (
        <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" className={rounded < 0 ? 'rotate-180' : undefined}>
          <path d="M4 6.5V1.5M1.5 4 4 1.5 6.5 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {points ? t('todo.stats.compare.points', { value: signed }) : `${signed}%`}
    </span>
  )
}

/**
 * The five steps of the heat ramp.
 *
 * Painted as a value rather than as five Tailwind classes: a `color-mix()` inside an arbitrary value
 * works, but it is opaque to a reader and to anything that greps for a colour; this says what the
 * percentage means in one place.
 */
function heatFill(step: number): string {
  if (step <= 0) return 'var(--bg-inset)'
  const share = [0, 22, 42, 66, 100][step] ?? 100
  return share >= 100 ? 'var(--accent)' : `color-mix(in oklab, var(--accent) ${share}%, var(--bg-inset))`
}

/**
 * The weekday × hour heatmap.
 *
 * A grid of divs, not an SVG: 168 cells are cheap, they take their colour from the token the ramp is
 * built on, and each one can carry its own title. The rows are Monday-first, which is how a calendar is
 * read in both locales the app ships.
 */
export function WeekHourHeatmap({ cells }: { cells: readonly TaskStatsWeekdayHourCount[] }) {
  const { grid, max, busiest } = useMemo(() => {
    const table = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
    let top = 0
    let peak: TaskStatsWeekdayHourCount | null = null
    for (const cell of cells) {
      if (cell.weekday < 0 || cell.weekday > 6 || cell.hour < 0 || cell.hour > 23) continue
      table[cell.weekday]![cell.hour] = cell.completed
      if (cell.completed > top) { top = cell.completed; peak = cell }
    }
    return { grid: table, max: top, busiest: peak }
  }, [cells])
  const rows = [1, 2, 3, 4, 5, 6, 0]
  const hours = Array.from({ length: 24 }, (_, hour) => hour)
  const level = (value: number): number => (max === 0 || value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4)))
  const label = busiest
    ? t('todo.stats.heatmap.label', { weekday: new Intl.DateTimeFormat(localeTag(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + busiest.weekday))), hour: busiest.hour, count: max })
    : t('todo.stats.heatmap.empty')

  return (
    <div className="flex flex-col gap-1.5">
      <div role="img" aria-label={label} className="overflow-x-auto">
        <div className="min-w-[420px]">
          <div className="mb-1 grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-[2px] text-[length:var(--text-8-5)] tabular text-[var(--text-quaternary)]">
            <span aria-hidden="true" />
            {hours.map((hour) => (
              <span key={hour} className="text-center" aria-hidden="true">{hour % 3 === 0 ? hour : ''}</span>
            ))}
          </div>
          {rows.map((weekday) => (
            <div key={weekday} className="mb-[2px] grid grid-cols-[28px_repeat(24,minmax(0,1fr))] items-center gap-[2px]">
              <span className="pr-1 text-right text-[length:var(--text-9)] text-[var(--text-quaternary)]" aria-hidden="true">
                {narrowWeekdayLabel(localeTag(), weekday)}
              </span>
              {hours.map((hour) => {
                const value = grid[weekday]![hour]!
                const step = level(value)
                return (
                  <span
                    key={hour}
                    title={value > 0 ? t('todo.stats.heatmap.cell', { weekday: new Intl.DateTimeFormat(localeTag(), { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + weekday))), hour: String(hour).padStart(2, '0'), count: value }) : undefined}
                    className="h-3.5 rounded-[2px]"
                    style={{ backgroundColor: heatFill(step) }}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1 text-[length:var(--text-9)] text-[var(--text-quaternary)]" aria-hidden="true">
        <span>{t('todo.stats.heatmap.less')}</span>
        {[0, 1, 2, 3, 4].map((step) => (
          <span key={step} className="size-2.5 rounded-[2px]" style={{ backgroundColor: heatFill(step) }} />
        ))}
        <span>{t('todo.stats.heatmap.more')}</span>
      </div>
    </div>
  )
}

/** A donut of shares, with the total in the middle. */
export function Donut({ slices, caption, totalLabel }: { slices: readonly StatSlice[]; caption: string; totalLabel?: string }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const radius = 42
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <div className="flex items-center gap-4">
      <div className="relative shrink-0">
        <svg role="img" aria-label={caption} viewBox="0 0 100 100" className="size-24 -rotate-90">
          <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--bg-inset)" strokeWidth="14" />
          {total > 0 && slices.map((slice) => {
            const length = (slice.value / total) * circumference
            const dash = `${length} ${circumference - length}`
            const element = (
              <circle
                key={slice.key}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth="14"
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            )
            offset += length
            return element
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[length:var(--text-16)] font-semibold tabular text-[var(--text-primary)]">{total}</span>
          <span className="text-[length:var(--text-9)] text-[var(--text-quaternary)]">{totalLabel ?? t('todo.stats.donut_total')}</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-1">
        {slices.map((slice) => (
          <li key={slice.key} className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-11-5)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{slice.label}</span>
            <span className="shrink-0 tabular text-[var(--text-tertiary)]">{slice.value}</span>
            <span className="w-8 shrink-0 text-right tabular text-[var(--text-quaternary)]">{total > 0 ? percent(slice.value / total) : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** One bar per slice, painted in the slice's own colour — a list's colour is the one the reader picked. */
export function SliceBars({ slices, label }: { slices: readonly StatSlice[]; label: string }) {
  if (!slices.length) {
    return <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.stats.distribution.empty')}</p>
  }
  const max = Math.max(1, ...slices.map((slice) => slice.value))
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {slices.map((slice) => (
        <li key={slice.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--text-12)] text-[var(--text-secondary)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
            <span className="truncate">{slice.label}</span>
          </span>
          <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">
            {slice.display ?? slice.value} · {total > 0 ? percent(slice.value / total) : '—'}
          </span>
          <span aria-hidden="true" className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-inset)]">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (slice.value / max) * 100)}%`, backgroundColor: slice.color }} />
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One bar split into its parts: how the open work ages. */
export function StackedBar({ slices, label }: { slices: readonly StatSlice[]; label: string }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (total === 0) {
    return <p className="text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('todo.stats.distribution.empty')}</p>
  }
  return (
    <div className="flex flex-col gap-2">
      <div role="img" aria-label={label} className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
        {slices.filter((slice) => slice.value > 0).map((slice) => (
          <span key={slice.key} style={{ width: `${(slice.value / total) * 100}%`, backgroundColor: slice.color }} title={`${slice.label} ${slice.value}`} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            <span className="size-2 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
            {slice.label}
            <span className="tabular text-[var(--text-quaternary)]">{slice.value}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A duration in the words a reader would use, not in milliseconds. */
export function durationLabel(ms: number | null): string {
  if (ms === null) return '—'
  // A day nobody worked on is zero, and it has to read as zero. The rounding-up below is for a real
  // amount too small to print as 40 seconds — not for the absence of one, which a rounded-up "1 m" invents.
  if (ms <= 0) return t('todo.stats.duration.minutes', { value: '0' })
  const minutes = ms / MINUTE_MS
  if (minutes < 60) return t('todo.stats.duration.minutes', { value: String(Math.max(1, Math.round(minutes))) })
  const hours = minutes / 60
  if (hours < 24) return t('todo.stats.duration.hours', { value: hours.toFixed(1) })
  return t('todo.stats.duration.days', { value: (hours / 24).toFixed(1) })
}

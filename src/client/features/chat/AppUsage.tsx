/**
 * The account's own usage, over its whole life.
 *
 * A second view of the same screen rather than a second screen: the total, the busiest day, the longest
 * turn and the streak are all facts about everything the reader has ever spent, so none of them follows the
 * range control — a cumulative total that reset when the range changed would not be cumulative. The range
 * belongs to the trend and the model ranking below, which are window-scoped like the detail view's numbers.
 *
 * The activity map is the one figure here that is read rather than looked at, which is why it has three
 * readings of the same squares rather than three maps: what the day cost, what its week cost, or how much
 * had accumulated by then.
 */
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AssistantStats, AssistantUsageOverview } from '@shared/assistant'
import { localeTag, t, useLocale } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { cn } from '../../lib/cn'
import { TokenTrend } from './UsageCharts'
import { compact, money } from './usage-format'

const RANGES = ['7', '30', 'all'] as const
type Range = (typeof RANGES)[number]

/** How the activity map's squares are measured, all three over the same grid. */
const HEAT_MODES = ['daily', 'weekly', 'cumulative'] as const
type HeatMode = (typeof HEAT_MODES)[number]

const DAY_MS = 86_400_000
/** A square and the gap beside it, which is what a month label's width is counted in. */
const CELL_PX = 15

/** A turn's length in whole minutes, which is the unit the figure is read in. */
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000))

/** The Monday of the week a day falls in: the map's columns are weeks, and they start on Monday. */
function weekStart(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`).getTime()
  return new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10)
}

interface HeatCell {
  day: string
  tokens: number
  level: number
}

/**
 * The year as a week-per-column grid, measured the way the switch asks.
 *
 * Every day between the first one spent and today gets a square, including the quiet ones — a map that
 * skipped them would compress a month off a week off and show a shape the reader never had. A week's
 * reading is one value spread over its seven squares, which is what makes "which weeks were heavy" legible
 * without a second layout to learn.
 */
function heatCells(activity: readonly { day: string, tokens: number }[], mode: HeatMode, today: string): HeatCell[] {
  const spent = new Map(activity.map((entry) => [entry.day, entry.tokens]))
  const weeks = new Map<string, number>()
  for (const entry of activity) {
    const key = weekStart(entry.day)
    weeks.set(key, (weeks.get(key) ?? 0) + entry.tokens)
  }
  const start = weekStart(activity[0]?.day ?? today)
  // Padded to whole weeks at both ends: a partial last column would leave the grid a ragged shape, and the
  // row a reader scans to find "this week" would be the one that stops early.
  const end = new Date(Date.parse(`${weekStart(today)}T00:00:00.000Z`) + 6 * DAY_MS).toISOString().slice(0, 10)
  const out: Array<{ day: string, tokens: number }> = []
  let running = 0
  for (let at = Date.parse(`${start}T00:00:00.000Z`); at <= Date.parse(`${end}T00:00:00.000Z`); at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10)
    const tokens = spent.get(day) ?? 0
    running += tokens
    out.push({ day, tokens: mode === 'daily' ? tokens : mode === 'weekly' ? weeks.get(weekStart(day)) ?? 0 : running })
  }
  const peak = Math.max(1, ...out.map((entry) => entry.tokens))
  // Five steps rather than a continuous tint: a reader compares squares, and forty shades of one colour is
  // a comparison nobody can make by eye.
  return out.map((entry) => ({ ...entry, level: entry.tokens === 0 ? 0 : Math.min(4, Math.ceil((entry.tokens / peak) * 4)) }))
}

/** Where each month's name sits, and how many columns of squares it covers. */
function monthLabels(cells: readonly HeatCell[]): Array<{ key: string, label: string, span: number }> {
  const months: Array<{ key: string, label: string, span: number }> = []
  cells.forEach((cell, index) => {
    if (index % 7 !== 0) return
    const key = cell.day.slice(0, 7)
    if (months.at(-1)?.key === key) {
      months[months.length - 1]!.span++
      return
    }
    months.push({ key, label: new Date(`${cell.day}T00:00:00.000Z`).toLocaleDateString(localeTag(), { month: 'short' }), span: 1 })
  })
  // A label over one column would print on top of the next one, so the last month keeps whatever is left.
  if (months.length > 1 && months[months.length - 1]!.span < 2) {
    months[months.length - 2]!.span += months.pop()!.span
  }
  return months
}

/**
 * The activity map.
 *
 * Drawn as a grid rather than through the notebook's calendar: that component is the calendar app's, with a
 * cursor, a lunar layer and a day-click contract, and dragging all of it into a settings panel to show a
 * year of intensity would be a page of props for a grid of squares.
 */
function ActivityHeatmap({ activity, mode, today }: {
  activity: readonly { day: string, tokens: number }[]
  mode: HeatMode
  today: string
}) {
  const cells = useMemo(() => heatCells(activity, mode, today), [activity, mode, today])
  const months = useMemo(() => monthLabels(cells), [cells])
  return (
    <div className="no-scrollbar overflow-x-auto pb-1">
      <div className="inline-block">
        <div className="flex">
          {months.map((entry) => (
            <span
              key={entry.key}
              className="shrink-0 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]"
              style={{ width: `${entry.span * CELL_PX}px` }}
            >
              {entry.label}
            </span>
          ))}
        </div>
        <div role="group" aria-label={t('assistant.stats.heatmap')} className="mt-1 inline-grid grid-flow-col grid-rows-7 gap-[3px]">
          {cells.map((cell) => (
            <span
              key={cell.day}
              title={t('assistant.stats.day_tokens', { day: cell.day, tokens: cell.tokens.toLocaleString() })}
              aria-label={t('assistant.stats.day_tokens', { day: cell.day, tokens: cell.tokens.toLocaleString() })}
              className={cn('size-3 rounded-[3px]', cell.level === 0 && 'bg-[var(--bg-inset)]')}
              style={cell.level > 0 ? { background: `color-mix(in oklab, var(--accent) ${cell.level * 25}%, var(--bg-inset))` } : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Each model's share of the window, most used first, with what it cost where the reader has priced it. */
function ModelRanking({ models }: { models: AssistantStats['models'] }) {
  const peak = Math.max(1, ...models.map((model) => model.inputTokens + model.outputTokens))
  return (
    <ul className="space-y-1">
      {models.map((model) => {
        const tokens = model.inputTokens + model.outputTokens
        return (
          <li key={model.label} className="flex items-center gap-2 text-[length:var(--text-12)]">
            <span className="w-40 shrink-0 truncate text-[var(--text-secondary)]" title={model.label}>
              {model.label || t('assistant.stats.unknown_model')}
            </span>
            <span aria-hidden className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
              <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, (tokens / peak) * 100)}%` }} />
            </span>
            <span className="shrink-0 tabular text-[var(--text-tertiary)]">{model.requests} · {compact(tokens)}</span>
            <span className="w-28 shrink-0 text-right tabular text-[var(--text-quaternary)]">
              {model.cost === null ? t('assistant.stats.no_price') : money(model.cost, model.currency)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export function AppUsage() {
  const [range, setRange] = useState<Range>('7')
  const [mode, setMode] = useState<HeatMode>('daily')
  const [overview, setOverview] = useState<AssistantUsageOverview | null>(null)
  const [stats, setStats] = useState<AssistantStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  useLocale()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    // The totals and the window are two questions with two answers, so they are asked together and each
    // keeps its own failure: a trend that cannot be read must not take the streak down with it.
    void Promise.all([
      api.assistant.usageOverview().then((result) => result.overview).catch(() => null),
      api.assistant.stats(range).catch(() => null),
    ]).then(([nextOverview, nextStats]) => {
      if (cancelled) return
      setOverview(nextOverview)
      setStats(nextStats)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [range, reload])

  if (loading && !overview) {
    return <div className="flex justify-center py-6"><Spinner /></div>
  }
  if (!overview) {
    return <p className="py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.stats.unavailable')}</p>
  }

  const today = new Date().toISOString().slice(0, 10)
  const figures: Array<[string, string]> = [
    [t('assistant.stats.total_tokens'), overview.totalTokens.toLocaleString()],
    [t('assistant.stats.peak_tokens'), overview.peakTokens.toLocaleString()],
    [t('assistant.stats.longest_turn'), t('assistant.stats.minutes', { count: minutes(overview.longestTurnMs) })],
    [t('assistant.stats.current_streak'), t('assistant.stats.days', { count: overview.currentStreak })],
    [t('assistant.stats.longest_streak'), t('assistant.stats.days', { count: overview.longestStreak })],
  ]

  return (
    <div className="space-y-3 py-2">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
            <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</p>
            <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.heatmap')}</p>
          <Segmented
            size="sm"
            label={t('assistant.stats.heat_mode')}
            value={mode}
            onChange={(next) => setMode(next as HeatMode)}
            options={HEAT_MODES.map((entry) => ({ value: entry, label: t(`assistant.stats.heat_${entry}`) }))}
          />
        </div>
        <ActivityHeatmap activity={overview.activity} mode={mode} today={today} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={t('assistant.stats.range')}
          value={range}
          onChange={(next) => setRange(next as Range)}
          options={RANGES.map((entry) => ({ value: entry, label: t(`assistant.stats.range_${entry}`) }))}
        />
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>
          <RefreshCw size={13} />
          {t('common.refresh')}
        </Button>
      </div>

      {!stats || stats.days.length === 0 ? (
        <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
          {t('assistant.stats.empty')}
        </p>
      ) : (
        <>
          <div>
            <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.daily_tokens')}</p>
            <TokenTrend days={stats.days} />
          </div>
          {stats.models.length > 0 && (
            <div>
              <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.by_model')}</p>
              <ModelRanking models={stats.models} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

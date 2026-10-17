/**
 * The usage screen's charts.
 *
 * Chart.js, because the app already ships it for note charts and the job here is the same one: a reader
 * comparing days. Each chart supplies only its own config — the library is imported on the first draw, the
 * colours come from the account's accent through the same palette the note charts use, and every canvas is
 * destroyed with its effect, because a chart left behind holds a resize observer and repaints off screen.
 *
 * Cost is drawn one currency at a time. A window priced in two is two bills, and stacking them would be
 * adding different money together; the panel names the currency it is showing instead.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { ChartConfiguration } from 'chart.js'
import type { AssistantStats, AssistantUsageDay, AssistantUsageSlice } from '@shared/assistant'
import { t } from '../../lib/i18n'
import { chartPalette } from '../../lib/markdown/chart'
import { useThemeDark } from '../../lib/hooks'
import { compact } from './usage-format'

interface ChartColors {
  palette: string[]
  text: string
  grid: string
}

/** A translucent fill for an area series, from the opaque hex the palette hands out. */
function withAlpha(color: string, alpha: number): string {
  if (!color.startsWith('#') || color.length !== 7) return color
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
}

/**
 * One chart.js canvas, with the housekeeping every chart on this screen shares.
 *
 * `build` is memoised by the caller on the data it closes over, which is what makes this effect re-run when
 * the window or the grouping changes rather than on every render.
 */
function ChartCanvas({ height, label, build }: {
  height: string
  label: string
  /** Memoised on the data behind it: a new function each render would redraw the chart each render. */
  build: (colors: ChartColors) => ChartConfiguration
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dark = useThemeDark()
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let chart: { destroy: () => void } | null = null
    let cancelled = false
    void import('chart.js/auto').then(({ default: Chart }) => {
      if (cancelled || !canvas.current) return
      const styles = getComputedStyle(document.documentElement)
      const colors: ChartColors = {
        palette: chartPalette(dark),
        text: styles.getPropertyValue('--text-quaternary').trim() || '#888',
        grid: dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
      }
      // Drawing is the one thing here that can fail on its own — a context that cannot be had, a library
      // that will not load — and the numbers above it are what the reader came for. Best-effort, then.
      try {
        chart = new Chart(canvas.current, build(colors))
      } catch {
        chart = null
      }
    })
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [build, dark])
  return (
    <div className={height}>
      <canvas ref={canvas} aria-label={label} role="img" />
    </div>
  )
}

const slicesOf = (day: AssistantUsageDay, group: 'model' | 'key'): AssistantUsageSlice[] =>
  group === 'model' ? day.models : day.keys

const costIn = (slice: AssistantUsageSlice | undefined, currency: string): number =>
  slice?.costs.find((entry) => entry.currency === currency)?.amount ?? 0

/** The same model's row for one day, which a quiet day simply does not have. */
const modelOn = (day: AssistantUsageDay, label: string): AssistantUsageSlice | undefined =>
  day.models.find((slice) => slice.id === label)

/** A cost axis reads in the same decimals the totals do: fractions of a unit for a cheap window. */
const costTick = (value: number): string => value.toFixed(value < 1 ? 4 : 2)

/** What was spent each day, stacked by whichever dimension the reader is asking about. */
export function CostBars({ series, group, currency }: {
  series: AssistantUsageDay[]
  group: 'model' | 'key'
  currency: string
}) {
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration => {
    // Only what actually cost something: a slice of an unpriced model is a legend entry with no bar, and
    // the panel already says how many models were left out of the total.
    const named = new Map<string, string>()
    for (const day of series) {
      for (const slice of slicesOf(day, group)) {
        if (costIn(slice, currency) > 0 && !named.has(slice.id)) named.set(slice.id, slice.label)
      }
    }
    return {
      type: 'bar',
      data: {
        labels: series.map((day) => day.day.slice(5)),
        datasets: [...named].map(([id, label], index) => ({
          label: label || t('assistant.stats.unknown_model'),
          data: series.map((day) => costIn(slicesOf(day, group).find((slice) => slice.id === id), currency)),
          backgroundColor: colors.palette[index % colors.palette.length],
          borderRadius: 2,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
        scales: {
          x: { stacked: true, ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: (value) => costTick(Number(value)) }, grid: { color: colors.grid } },
        },
      },
    }
  }, [series, group, currency])
  return <ChartCanvas height="h-44" label={t('assistant.stats.cost_chart')} build={build} />
}

/**
 * One model's own window: how often it was asked, and what it was asked to read and write.
 *
 * Two charts rather than one with two axes, because requests and tokens are different quantities — a model
 * asked twice with a huge prompt and one asked twice with a small one look the same on a shared axis.
 */
export function ModelTrend({ series, label, totals }: {
  series: AssistantUsageDay[]
  label: string
  /** The model's own window totals, which are the authority on what it spent. The daily series may cover
   *  less history than the totals do (requests recorded before the key dimension existed have no day
   *  rows), and a heading read off the series alone would then say zero. */
  totals?: { requests: number, tokens: number }
}) {
  const requests = useMemo(() => (colors: ChartColors): ChartConfiguration => {
    const totals = series.map((day) => modelOn(day, label)?.requests ?? 0)
    return {
      type: 'line',
      data: {
        labels: series.map((day) => day.day.slice(5)),
        datasets: [{
          label: t('assistant.stats.requests'),
          data: totals,
          borderColor: colors.palette[0],
          backgroundColor: withAlpha(colors.palette[0] ?? '', 0.18),
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, precision: 0 }, grid: { color: colors.grid } },
        },
      },
    }
  }, [series, label])

  const tokens = useMemo(() => (colors: ChartColors): ChartConfiguration => ({
    type: 'bar',
    data: {
      labels: series.map((day) => day.day.slice(5)),
      datasets: [
        { label: t('assistant.stats.tokens_in'), data: series.map((day) => modelOn(day, label)?.inputTokens ?? 0), backgroundColor: colors.palette[0], borderRadius: 2 },
        { label: t('assistant.stats.tokens_out'), data: series.map((day) => modelOn(day, label)?.outputTokens ?? 0), backgroundColor: withAlpha(colors.palette[0] ?? '', 0.45), borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { stacked: true, ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: (value) => compact(Number(value)) }, grid: { color: colors.grid } },
      },
    },
  }), [series, label])

  const plotted = series.reduce(
    (sum, day) => {
      const slice = modelOn(day, label)
      return { requests: sum.requests + (slice?.requests ?? 0), tokens: sum.tokens + (slice?.inputTokens ?? 0) + (slice?.outputTokens ?? 0) }
    },
    { requests: 0, tokens: 0 },
  )
  const shown = totals ?? plotted
  // Totals with nothing under them mean the window predates the daily dimension, not a model that did
  // no work: the cards lend their number to the totals and say why the curves are empty.
  const withoutSeries = Boolean(totals) && (totals!.requests > 0 || totals!.tokens > 0)
    && plotted.requests === 0 && plotted.tokens === 0

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
          <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('assistant.stats.requests')} <span className="tabular text-[var(--text-secondary)]">{shown.requests.toLocaleString()}</span>
          </p>
          <ChartCanvas height="h-32" label={t('assistant.stats.requests_chart', { model: label })} build={requests} />
        </div>
        <div className="rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2">
          <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
            {t('assistant.stats.tokens')} <span className="tabular text-[var(--text-secondary)]">{compact(shown.tokens)}</span>
          </p>
          <ChartCanvas height="h-32" label={t('assistant.stats.tokens_chart', { model: label })} build={tokens} />
        </div>
      </div>
      {withoutSeries && (
        <p className="text-[length:var(--text-11)] leading-relaxed text-[var(--text-quaternary)]">{t('assistant.stats.series_unavailable')}</p>
      )}
    </div>
  )
}

/** The window's tokens in and out, day by day: the shape a reader reads a week by. */
export function TokenTrend({ days }: { days: AssistantStats['days'] }) {
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration => ({
    type: 'bar',
    data: {
      labels: days.map((entry) => entry.day.slice(5)),
      datasets: [
        { label: t('assistant.stats.tokens_in'), data: days.map((entry) => entry.inputTokens), backgroundColor: colors.palette[0], borderRadius: 2 },
        { label: t('assistant.stats.tokens_out'), data: days.map((entry) => entry.outputTokens), backgroundColor: withAlpha(colors.palette[0] ?? '', 0.45), borderRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { labels: { color: colors.text, boxWidth: 10, font: { size: 10 } } } },
      scales: {
        x: { stacked: true, ticks: { color: colors.text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { color: colors.text, font: { size: 10 }, callback: (value) => compact(Number(value)) }, grid: { color: colors.grid } },
      },
    },
  }), [days])
  return <ChartCanvas height="h-40" label={t('assistant.stats.daily_tokens')} build={build} />
}

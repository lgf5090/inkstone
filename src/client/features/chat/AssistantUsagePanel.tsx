/**
 * What the assistant has been spending, drawn from one answer.
 *
 * Three views of one window rather than three independent widgets: the totals, the days and the models
 * all come from a single `/stats` response, so a range switch cannot leave one panel describing last
 * week and another describing last month. The chart library is loaded on the first draw and shared with
 * the note charts, which reach the same chunk.
 *
 * Cost is shown per currency and never added across them. A model the reader has not priced is reported
 * as unpriced — "no price" and "free" are different claims, and a total that confused them would be a
 * number nobody could act on.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Coins, RefreshCw } from 'lucide-react'
import type { AssistantStats } from '@shared/assistant'
import { t, useLocale } from '../../lib/i18n'
import { api } from '../../lib/api'
import { Button, Spinner } from '../../components/primitives'
import { Segmented } from '../../components/form'
import { cn } from '../../lib/cn'
import { useThemeDark } from '../../lib/hooks'
import { Group } from './assistant-settings-shared'

const RANGES = ['7', '30', 'all'] as const
type Range = (typeof RANGES)[number]

/** Tokens, shortened the way a reader reads them at a glance. */
function compact(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function money(amount: number, currency: string): string {
  // Four decimals because a single cheap turn is fractions of a cent, and rounding it to two would show
  // a reader who just spent something the same numbers as one who spent nothing.
  return `${currency} ${amount.toFixed(amount < 1 ? 4 : 2)}`
}

/**
 * The daily token bars.
 *
 * Chart.js rather than a hand-drawn SVG because the app already ships it for note charts, and because
 * the two series — tokens in and tokens out — are what the reader compares day by day. The canvas is
 * destroyed with the effect: a chart left behind holds its resize observer and repaints off screen.
 */
function TokenTrend({ days, dark }: { days: AssistantStats['days'], dark: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element || !days.length) return
    let chart: { destroy: () => void } | null = null
    let cancelled = false
    void import('chart.js/auto').then(({ default: Chart }) => {
      if (cancelled || !canvas.current) return
      const styles = getComputedStyle(document.documentElement)
      const accent = styles.getPropertyValue('--accent').trim() || '#c0392b'
      const text = styles.getPropertyValue('--text-quaternary').trim() || '#888'
      // Drawing is the one thing here that can fail on its own — a context that cannot be had, a library
      // that will not load — and the numbers above it are what the reader came for. So the chart is
      // best-effort and the panel stays.
      try {
        chart = new Chart(canvas.current, {
        type: 'bar',
        data: {
          labels: days.map((entry) => entry.day.slice(5)),
          datasets: [
            { label: t('assistant.stats.tokens_in'), data: days.map((entry) => entry.inputTokens), backgroundColor: accent, borderRadius: 2 },
            { label: t('assistant.stats.tokens_out'), data: days.map((entry) => entry.outputTokens), backgroundColor: `color-mix(in oklab, ${accent} 45%, transparent)`, borderRadius: 2 },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { labels: { color: text, boxWidth: 10, font: { size: 10 } } } },
          scales: {
            x: { stacked: true, ticks: { color: text, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 }, grid: { display: false } },
            y: { stacked: true, ticks: { color: text, font: { size: 10 }, callback: (value) => compact(Number(value)) }, grid: { color: `color-mix(in oklab, ${text} 18%, transparent)` } },
          },
        },
        })
      } catch {
        chart = null
      }
    })
    return () => {
      cancelled = true
      chart?.destroy()
    }
  }, [days, dark])
  return (
    <div className="h-40 w-full">
      <canvas ref={canvas} aria-label={t('assistant.stats.daily_tokens')} role="img" />
    </div>
  )
}

/**
 * The window as a year of days.
 *
 * Drawn here rather than through the notebook's calendar: that component is the calendar app's, with a
 * cursor, a lunar layer and a day-click contract, and dragging all of it into a settings panel to show
 * one year of intensity would be a page of props for a grid of squares.
 */
function UsageHeatmap({ counts, from, to }: { counts: ReadonlyMap<string, number>, from: string, to: string }) {
  const cells = useMemo(() => {
    const start = new Date(`${from}T00:00:00.000Z`)
    const end = new Date(`${to}T00:00:00.000Z`)
    const peak = Math.max(1, ...[...counts.values()])
    const out: Array<{ key: string, level: number, tokens: number }> = []
    for (let time = start.getTime(); time <= end.getTime(); time += 86_400_000) {
      const key = new Date(time).toISOString().slice(0, 10)
      const tokens = counts.get(key) ?? 0
      // Five steps rather than a continuous tint: a reader compares squares, and forty shades of one
      // colour is a comparison nobody can make by eye.
      const level = tokens === 0 ? 0 : Math.min(4, Math.ceil((tokens / peak) * 4))
      out.push({ key, level, tokens })
    }
    return out
  }, [counts, from, to])
  return (
    <div role="group" aria-label={t('assistant.stats.heatmap')} className="flex flex-wrap gap-[3px]">
      {cells.map((cell) => (
        <span
          key={cell.key}
          title={t('assistant.stats.day_tokens', { day: cell.key, tokens: cell.tokens.toLocaleString() })}
          aria-label={t('assistant.stats.day_tokens', { day: cell.key, tokens: cell.tokens.toLocaleString() })}
          className={cn(
            'size-3 rounded-[3px]',
            cell.level === 0 && 'bg-[var(--bg-inset)]',
          )}
          style={cell.level > 0 ? { background: `color-mix(in oklab, var(--accent) ${cell.level * 25}%, var(--bg-inset))` } : undefined}
        />
      ))}
    </div>
  )
}

export function UsagePanel() {
  const [range, setRange] = useState<Range>('7')
  const [stats, setStats] = useState<AssistantStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const dark = useThemeDark()
  useLocale()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api.assistant.stats(range).then((result) => {
      if (cancelled) return
      setStats(result)
    }).catch(() => {
      if (!cancelled) setStats(null)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [range, reload])

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const day of stats?.days ?? []) map.set(day.day, day.inputTokens + day.outputTokens)
    return map
  }, [stats])

  const peakTokens = Math.max(1, ...(stats?.models ?? []).map((model) => model.inputTokens + model.outputTokens))

  return (
    <>
      <Group title={t('assistant.stats.title')}>
        <div className="flex flex-wrap items-center gap-2 py-2">
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

        {loading && !stats ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : !stats ? (
          <p className="py-3 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('assistant.stats.unavailable')}</p>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                [t('assistant.stats.requests'), stats.total.requests.toLocaleString()],
                [t('assistant.stats.tokens_in'), compact(stats.total.inputTokens)],
                [t('assistant.stats.tokens_out'), compact(stats.total.outputTokens)],
                [t('assistant.stats.tools'), stats.total.toolCalls.toLocaleString()],
              ].map(([label, value]) => (
                <div key={label} className="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
                  <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</p>
                  <p className="mt-0.5 text-[length:var(--text-15)] font-semibold tabular text-[var(--text-primary)]">{value}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-12)]">
              <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                <Coins size={13} className="text-[var(--text-quaternary)]" />
                {t('assistant.stats.cost')}
              </span>
              {stats.spend.length === 0
                ? <span className="text-[var(--text-quaternary)]">{t('assistant.stats.cost_none')}</span>
                : stats.spend.map((entry) => (
                    <span key={entry.currency} className="tabular text-[var(--text-primary)]">{money(entry.amount, entry.currency)}</span>
                  ))}
              {stats.unpricedModels > 0 && (
                <span className="text-[var(--text-quaternary)]">{t('assistant.stats.unpriced', { count: stats.unpricedModels })}</span>
              )}
            </div>

            {stats.days.length > 0 && (
              <div>
                <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.daily_tokens')}</p>
                <TokenTrend days={stats.days} dark={dark} />
              </div>
            )}

            <div>
              <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.heatmap')}</p>
              <UsageHeatmap counts={counts} from={stats.from} to={stats.to} />
            </div>

            {stats.models.length > 0 && (
              <div>
                <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.by_model')}</p>
                <ul className="space-y-1">
                  {stats.models.map((model) => {
                    const tokens = model.inputTokens + model.outputTokens
                    return (
                      <li key={model.label} className="flex items-center gap-2 text-[length:var(--text-12)]">
                        <span className="w-40 shrink-0 truncate text-[var(--text-secondary)]" title={model.label}>{model.label || t('assistant.stats.unknown_model')}</span>
                        <span aria-hidden className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-[var(--bg-inset)]">
                          <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, (tokens / peakTokens) * 100)}%` }} />
                        </span>
                        <span className="shrink-0 tabular text-[var(--text-tertiary)]">{model.requests} · {compact(tokens)}</span>
                        <span className="w-28 shrink-0 text-right tabular text-[var(--text-quaternary)]">
                          {model.cost === null ? t('assistant.stats.no_price') : money(model.cost, model.currency)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {stats.conversations.length > 0 && (
              <div>
                <p className="mb-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t('assistant.stats.by_conversation')}</p>
                <ul className="space-y-0.5">
                  {stats.conversations.map((conversation) => (
                    <li key={conversation.id} className="flex items-center gap-2 text-[length:var(--text-12)]">
                      <span className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">{conversation.title || t('assistant.chat.untitled')}</span>
                      <span className="shrink-0 tabular text-[var(--text-quaternary)]">
                        {conversation.requests} · {compact(conversation.inputTokens + conversation.outputTokens)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Group>
    </>
  )
}

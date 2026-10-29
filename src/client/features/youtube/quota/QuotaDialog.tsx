import { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import {
  YOUTUBE_SEARCH_COST,
  type YouTubeQuotaBreakdown,
  type YouTubeQuotaData,
} from '@shared/youtube/model'
import type { MessageKey } from '@shared/locales/en-US'
import { Badge, Button, IconButton } from '../../../components/primitives'
import { LoadingBlock } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { cn } from '../../../lib/cn'
import { t } from '../../../lib/i18n'
import { formatNumber } from '../../../lib/time'
import { fetchQuota } from '../api'

/** The endpoint names the ledger stores, and the catalog key each one is shown under. */
const ENDPOINT_KEYS: Readonly<Record<string, MessageKey>> = {
  search: 'youtube.endpoint.search',
  videos: 'youtube.endpoint.videos',
  channels: 'youtube.endpoint.channels',
  playlists: 'youtube.endpoint.playlists',
  playlistItems: 'youtube.endpoint.playlist_items',
  commentThreads: 'youtube.endpoint.comments',
}

/** One token per endpoint, so the breakdown rows stay distinguishable without a colour table. */
const ENDPOINT_BARS: Readonly<Record<string, string>> = {
  search: 'bg-[var(--danger)]',
  videos: 'bg-[var(--accent)]',
  channels: 'bg-[var(--success)]',
  playlists: 'bg-[var(--warning)]',
  playlistItems: 'bg-[var(--text-tertiary)]',
  commentThreads: 'bg-[var(--text-quaternary)]',
}

const WARNING_PERCENT = 70
const DANGER_PERCENT = 90
const MIN_BAR_PERCENT = 2

/**
 * What this deployment has spent of its shared YouTube Data API quota.
 *
 * The ledger is instance-wide because the key is. Every figure comes from the worker's own request
 * log, so the panel is a report rather than a live gauge: the refresh button asks again, and seven
 * UTC days arrive with zero-filled gaps so the chart never skips a date.
 */
export function QuotaDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<YouTubeQuotaData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (reset: boolean) => {
    const generation = ++generationRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    setError(null)
    if (reset) setData(null)
    try {
      const quota = await fetchQuota(controller.signal)
      if (generation === generationRef.current) setData(quota)
    } catch (cause) {
      if (generation === generationRef.current && !controller.signal.aborted) {
        setError(messageOf(cause))
      }
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) {
      generationRef.current++
      abortRef.current?.abort()
      return
    }
    void load(true)
  }, [open, load])

  useEffect(() => () => abortRef.current?.abort(), [])

  const percent = data ? quotaPercent(data.today.total, data.limit) : 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title={
        <span className="flex min-w-0 items-center gap-[var(--sp-1-5)]">
          <Gauge size={17} aria-hidden="true" className="shrink-0 text-[var(--accent)]" />
          <span className="truncate">{t('youtube.quota.title')}</span>
          <IconButton
            label={t('common.refresh')}
            size="sm"
            className="ml-[var(--sp-1)]"
            disabled={loading}
            onClick={() => void load(false)}
          >
            <RefreshCw size={13} className={cn(loading && 'animate-[ink-spin_0.7s_linear_infinite]')} />
          </IconButton>
        </span>
      }
    >
      {loading && !data ? (
        <LoadingBlock label={t('common.loading')} />
      ) : error ? (
        <div className="flex flex-col items-center gap-[var(--sp-2)] py-[var(--sp-8)] text-center">
          <p role="alert" className="max-w-[42ch] text-[length:var(--text-12)] leading-relaxed text-[var(--danger)]">
            {error}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load(false)}>
            {t('youtube.retry')}
          </Button>
        </div>
      ) : data && !data.configured ? (
        <div className="space-y-[var(--sp-2)] py-[var(--sp-4)]">
          <p className="text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">
            {t('youtube.quota.not_configured')}
          </p>
          <p className="text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
            {t('youtube.quota.not_configured_desc')}
          </p>
        </div>
      ) : data ? (
        <QuotaBody data={data} percent={percent} />
      ) : null}
    </Modal>
  )
}

function QuotaBody({ data, percent }: { data: YouTubeQuotaData; percent: number }) {
  const tone = percent >= DANGER_PERCENT ? 'danger' : percent >= WARNING_PERCENT ? 'warning' : 'neutral'
  const searchesLeft = Math.floor(data.today.remaining / YOUTUBE_SEARCH_COST)
  const maxHistory = Math.max(1, ...data.history.map((entry) => entry.units))
  const maxWeek = Math.max(1, ...data.weekBreakdown.map((entry) => entry.units))
  const costs = Object.entries(data.quotaCosts).sort((left, right) => right[1] - left[1])

  return (
    <div className="space-y-[var(--sp-5)]">
      <section
        aria-label={t('youtube.quota.today')}
        className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-[var(--sp-4)]"
      >
        <div className="flex items-baseline justify-between gap-[var(--sp-3)]">
          <h3 className="text-[length:var(--text-12-5)] font-medium text-[var(--text-secondary)]">
            {t('youtube.quota.today')}
          </h3>
          <span className="text-[length:var(--text-11)] tabular text-[var(--text-quaternary)]">
            {data.today.date}
          </span>
        </div>
        <div className="mt-[var(--sp-2)] flex flex-wrap items-baseline gap-x-[var(--sp-2)] gap-y-1">
          <span className="text-[length:var(--text-16)] font-semibold tabular text-[var(--text-primary)]">
            {formatNumber(data.today.total)}
          </span>
          <span className="text-[length:var(--text-12)] tabular text-[var(--text-tertiary)]">
            / {formatNumber(data.limit)}
          </span>
          <Badge tone={tone} className="ml-auto tabular">
            {`${percent.toFixed(1)}%`}
          </Badge>
        </div>
        <div
          role="progressbar"
          aria-label={t('youtube.quota.today')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="mt-[var(--sp-2)] h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-hover)]"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]',
              percent >= DANGER_PERCENT
                ? 'bg-[var(--danger)]'
                : percent >= WARNING_PERCENT
                  ? 'bg-[var(--warning)]'
                  : 'bg-[var(--accent)]',
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-[var(--sp-2)] flex flex-wrap gap-x-[var(--sp-4)] gap-y-1 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          <span>{t('youtube.quota.remaining', { count: formatNumber(data.today.remaining) })}</span>
          <span>{t('youtube.quota.searches_left', { count: formatNumber(searchesLeft) })}</span>
        </div>
      </section>

      {data.today.breakdown.length > 0 && (
        <section aria-label={t('youtube.quota.today_breakdown')}>
          <h3 className="mb-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('youtube.quota.today_breakdown')}
          </h3>
          <div className="space-y-[var(--sp-1-5)]">
            {data.today.breakdown.map((item) => (
              <BreakdownBar
                key={item.endpoint}
                item={item}
                percent={share(item.units, data.today.total)}
              />
            ))}
          </div>
        </section>
      )}

      {data.history.length > 0 && (
        <section aria-label={t('youtube.quota.history')}>
          <h3 className="mb-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('youtube.quota.history')}
          </h3>
          <div className="flex h-[120px] items-end gap-[var(--sp-1)]">
            {data.history.map((entry) => {
              const isToday = entry.date === data.today.date
              const height = Math.max(MIN_BAR_PERCENT, (entry.units / maxHistory) * 100)
              return (
                <div key={entry.date} className="flex h-full flex-1 flex-col items-center justify-end gap-[var(--sp-1)]">
                  <span className="text-[length:var(--text-10)] tabular text-[var(--text-quaternary)]">
                    {entry.units > 0 ? formatNumber(entry.units) : ''}
                  </span>
                  <div
                    aria-hidden="true"
                    className={cn(
                      'w-full max-w-[40px] rounded-t-[var(--r-sm)]',
                      isToday ? 'bg-[var(--accent)]' : 'bg-[var(--accent-soft)]',
                    )}
                    style={{ height: `${height}%` }}
                  />
                  <span
                    className={cn(
                      'text-[length:var(--text-10)] tabular',
                      isToday ? 'text-[var(--text-secondary)]' : 'text-[var(--text-quaternary)]',
                    )}
                  >
                    {shortDate(entry.date)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {data.weekBreakdown.length > 0 && (
        <section aria-label={t('youtube.quota.week_breakdown')}>
          <h3 className="mb-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
            {t('youtube.quota.week_breakdown')}
          </h3>
          <div className="space-y-[var(--sp-1-5)]">
            {data.weekBreakdown.map((item) => (
              <div key={item.endpoint} className="flex items-center gap-[var(--sp-2)]">
                <span className="flex w-24 shrink-0 items-center gap-[var(--sp-1-5)]">
                  <span aria-hidden="true" className={cn('size-2.5 rounded-[2px]', endpointBar(item.endpoint))} />
                  <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
                    {endpointLabel(item.endpoint)}
                  </span>
                </span>
                <span className="relative h-4 flex-1 overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-hover)]">
                  <span
                    className={cn('block h-full rounded-[var(--r-sm)] opacity-80', endpointBar(item.endpoint))}
                    style={{ width: `${share(item.units, maxWeek)}%` }}
                  />
                </span>
                <span className="w-36 shrink-0 text-right text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">
                  {t('youtube.quota.calls', { units: formatNumber(item.units), count: formatNumber(item.count) })}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label={t('youtube.quota.costs')}>
        <h3 className="mb-[var(--sp-2)] text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">
          {t('youtube.quota.costs')}
        </h3>
        <div className="overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)]">
          <table className="w-full text-[length:var(--text-11-5)]">
            <thead className="bg-[var(--bg-sunken)] text-[var(--text-tertiary)]">
              <tr>
                <th scope="col" className="px-[var(--sp-3)] py-[var(--sp-1-5)] text-left font-medium">
                  {t('youtube.quota.endpoint')}
                </th>
                <th scope="col" className="px-[var(--sp-3)] py-[var(--sp-1-5)] text-right font-medium">
                  {t('youtube.quota.cost')}
                </th>
                <th scope="col" className="px-[var(--sp-3)] py-[var(--sp-1-5)] text-right font-medium">
                  {t('youtube.quota.calls_header')}
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.map(([endpoint, cost]) => (
                <tr key={endpoint} className="border-t border-[var(--border-subtle)]">
                  <td className="px-[var(--sp-3)] py-[var(--sp-1-5)]">
                    <span className="flex items-center gap-[var(--sp-1-5)]">
                      <span aria-hidden="true" className={cn('size-2 rounded-[2px]', endpointBar(endpoint))} />
                      {endpointLabel(endpoint)}
                    </span>
                  </td>
                  <td
                    className={cn(
                      'px-[var(--sp-3)] py-[var(--sp-1-5)] text-right font-medium tabular',
                      cost >= YOUTUBE_SEARCH_COST ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]',
                    )}
                  >
                    {formatNumber(cost)}
                  </td>
                  <td className="px-[var(--sp-3)] py-[var(--sp-1-5)] text-right tabular text-[var(--text-tertiary)]">
                    {t('youtube.quota.available', {
                      count: formatNumber(cost > 0 ? Math.floor(data.limit / cost) : 0),
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[length:var(--text-10)] leading-relaxed text-[var(--text-quaternary)]">
        {t('youtube.quota.footer')}
      </p>
    </div>
  )
}

function BreakdownBar({ item, percent }: { item: YouTubeQuotaBreakdown; percent: number }) {
  return (
    <div className="flex items-center gap-[var(--sp-2)]">
      <span className="flex w-24 shrink-0 items-center gap-[var(--sp-1-5)]">
        <span aria-hidden="true" className={cn('size-2.5 rounded-[2px]', endpointBar(item.endpoint))} />
        <span className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">
          {endpointLabel(item.endpoint)}
        </span>
      </span>
      <span className="relative h-4 flex-1 overflow-hidden rounded-[var(--r-sm)] bg-[var(--bg-hover)]">
        <span
          className={cn('block h-full rounded-[var(--r-sm)] opacity-80', endpointBar(item.endpoint))}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="w-36 shrink-0 text-right text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">
        {t('youtube.quota.calls', { units: formatNumber(item.units), count: formatNumber(item.count) })}
      </span>
      <span className="w-8 shrink-0 text-right text-[length:var(--text-10)] tabular text-[var(--text-tertiary)]">
        {`×${formatNumber(item.cost)}`}
      </span>
    </div>
  )
}

function quotaPercent(total: number, limit: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.min(100, Math.max(0, (total / limit) * 100))
}

function share(units: number, total: number): number {
  if (!Number.isFinite(units) || !Number.isFinite(total) || total <= 0) return MIN_BAR_PERCENT
  return Math.max(MIN_BAR_PERCENT, Math.min(100, (units / total) * 100))
}

function endpointLabel(endpoint: string): string {
  const key = ENDPOINT_KEYS[endpoint]
  return key ? t(key) : endpoint
}

function endpointBar(endpoint: string): string {
  return ENDPOINT_BARS[endpoint] ?? 'bg-[var(--accent)]'
}

/** The chart's own tick label: the month and day of a UTC date, without a locale round trip. */
function shortDate(date: string): string {
  const parts = date.split('-')
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : date
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

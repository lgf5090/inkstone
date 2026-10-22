/**
 * One link's own analytics.
 *
 * The question this screen answers is narrower than the dashboard's — "how is *this* address doing, over
 * this window, counting which traffic" — so everything on it is drawn from one reading
 * (`shareHubApi.analytics.note`) rather than stitched from several. The audit trail rides at the bottom
 * because the second thing an owner wants after a number that moved is what changed underneath it.
 *
 * Two things are deliberate. A breakdown renders every row the API answered, at whatever length it
 * answered: a card that quietly slices to five reports a top five under a heading that says "top
 * countries", and the owner has no way to notice the rest was dropped. And the visitor column prints the
 * label the server already truncated and nothing else — the raw digest never arrives here, so there is
 * nothing to leak.
 */
import { BarChart2, Lock, PauseCircle } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ChartConfiguration } from 'chart.js'
import type { ShareBreakdownItem, ShareNoteAnalytics, ShareTimelineRange } from '@shared/share-hub'
import { ChartCanvas, withAlpha } from '../../../components/chart-canvas'
import type { ChartColors } from '../../../components/chart-canvas'
import { Badge, Button } from '../../../components/primitives'
import { Checkbox, Segmented } from '../../../components/form'
import { Skeleton } from '../../../components/feedback'
import { Modal } from '../../../components/overlay'
import { shareHubApi } from '../../../lib/api-share-hub'
import { t } from '../../../lib/i18n'
import { formatNumber, fullTime, relativeTime } from '../../../lib/time'
import { ShareAuditHistory } from './audit-history'
import {
  REAL_VISITOR_TOGGLES,
  SHARE_RANGES,
  channelItemName,
  countryName,
  deviceLabel,
  locationLabel,
  rangeLabel,
  rowChannelName,
  trafficLabel,
  trafficParams,
  visitorLabel,
} from './share-readings'
import type { TrafficToggles } from './share-readings'

/** The modal's own width: six breakdown cards, two across, plus a chart that needs a readable x-axis. */
const MODAL_WIDTH = 880

type ReadState = 'loading' | 'ready' | 'error'

export function ShareNoteAnalyticsModal({
  noteId,
  noteTitle,
  onClose,
}: {
  noteId: string
  noteTitle: string
  onClose: () => void
}) {
  const [range, setRange] = useState<ShareTimelineRange>('30d')
  const [toggles, setToggles] = useState<TrafficToggles>(REAL_VISITOR_TOGGLES)
  const [metric, setMetric] = useState<'views' | 'visitors'>('views')
  const [data, setData] = useState<ShareNoteAnalytics | null>(null)
  const [state, setState] = useState<ReadState>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void shareHubApi.analytics.note(noteId, { range, ...trafficParams(toggles), signal: controller.signal })
      .then((response) => {
        setData(response)
        setState('ready')
      })
      .catch(() => {
        // The window changed mid-flight: this component replaced its own request, nothing failed.
        if (controller.signal.aborted) return
        setState('error')
      })
    return () => controller.abort()
  }, [noteId, range, toggles, attempt])

  const reload = useCallback(() => setAttempt((count) => count + 1), [])

  return (
    <Modal
      open
      onClose={onClose}
      width={MODAL_WIDTH}
      title={
        <span className="flex items-center gap-[var(--sp-1-5)]">
          <BarChart2 size={16} className="text-[var(--accent)]" aria-hidden="true" />
          {t('share.analytics_title')}
        </span>
      }
      description={data?.noteTitle || noteTitle}
    >
      <div className="flex flex-col gap-[var(--sp-3)] py-[var(--sp-1)]">
        {state === 'error' && (
          <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
            <p role="alert" className="text-[length:var(--text-12)] text-[var(--danger)]">
              {t('share.analytics_load_failed')}
            </p>
            <Button size="sm" variant="secondary" onClick={reload}>{t('common.retry')}</Button>
          </div>
        )}
        {state === 'loading' && data === null && (
          <div className="space-y-[var(--sp-2)]" aria-busy="true">
            <Skeleton className="h-[var(--sp-8)]" />
            <Skeleton className="h-40" />
          </div>
        )}
        <ReadingToolbar
          range={range}
          onRange={setRange}
          toggles={toggles}
          onToggles={setToggles}
          onRetry={reload}
          state={state}
        />
        {state === 'loading' && data !== null && (
          <p role="status" className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{t('common.loading')}</p>
        )}
        {data !== null && (
          <>
            <LinkIdentityBar data={data} />
            <TotalCards data={data} />
            <TimelineCard data={data} metric={metric} onMetric={setMetric} />
            <BreakdownGrid data={data} />
            <RecentVisitsCard data={data} />
          </>
        )}
        <ShareAuditHistory noteId={noteId} />
      </div>
    </Modal>
  )
}

/**
 * The window and the three exclusions.
 *
 * All three on is the app's "real visitors", and it is the same set the visit log selects with its
 * single-choice `real` filter — the log asks the server for it as a filter, the readings ask for it as
 * these three toggles, and both are written from `REAL_VISITOR_TOGGLES` so one change moves both.
 */
function ReadingToolbar({ range, onRange, toggles, onToggles, onRetry, state }: {
  range: ShareTimelineRange
  onRange: (range: ShareTimelineRange) => void
  toggles: TrafficToggles
  onToggles: (next: TrafficToggles) => void
  onRetry: () => void
  state: ReadState
}) {
  return (
    <div className="flex flex-col gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2-5)]">
      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <Segmented
          size="sm"
          label={t('share.reading_range_label')}
          value={range}
          onChange={onRange}
          options={SHARE_RANGES.map((option) => ({ value: option, label: rangeLabel(option) }))}
        />
        <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
          {trafficLabel(toggles)}
        </span>
        {state === 'ready' && (
          <Button size="sm" variant="ghost" onClick={onRetry}>{t('common.refresh')}</Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-[var(--sp-3)]" role="group" aria-label={t('share.reading_traffic_group')}>
        <Checkbox
          checked={toggles.bots}
          onChange={(bots) => onToggles({ ...toggles, bots })}
          label={t('share.reading_exclude_bots')}
        />
        <Checkbox
          checked={toggles.selfReferrers}
          onChange={(selfReferrers) => onToggles({ ...toggles, selfReferrers })}
          label={t('share.reading_exclude_self')}
        />
        <Checkbox
          checked={toggles.owner}
          onChange={(owner) => onToggles({ ...toggles, owner })}
          label={t('share.reading_exclude_owner')}
        />
      </div>
    </div>
  )
}

function LinkIdentityBar({ data }: { data: ShareNoteAnalytics }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-2-5)]">
      <p className="flex min-w-0 flex-wrap items-center gap-[var(--sp-1-5)] text-[length:var(--text-12)] text-[var(--text-secondary)]">
        <span className="font-mono font-semibold text-[var(--text-primary)]">{`/s/${data.slug}`}</span>
        {data.hasPassword && (
          <Badge tone="warning">
            <span className="flex items-center gap-[var(--sp-0-5)]">
              <Lock size={10} aria-hidden="true" />
              {t('share.password_protected')}
            </span>
          </Badge>
        )}
        {!data.isEnabled && (
          <Badge tone="neutral">
            <span className="flex items-center gap-[var(--sp-0-5)]">
              <PauseCircle size={10} aria-hidden="true" />
              {t('share.reading_link_paused')}
            </span>
          </Badge>
        )}
      </p>
      <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">
        {t('share.reading_created_on', { date: fullTime(data.createdAt) })}
        {data.expiresAt !== null ? ` · ${t('share.reading_expires_on', { date: fullTime(data.expiresAt) })}` : ''}
      </p>
    </div>
  )
}

function TotalCards({ data }: { data: ShareNoteAnalytics }) {
  return (
    <div className="grid grid-cols-2 gap-[var(--sp-2)]">
      <TotalCard label={t('share.total_views_pv')} value={data.totalViews} />
      <TotalCard label={t('share.total_visitors_uv')} value={data.totalVisitors} />
    </div>
  )
}

function TotalCard({ label, value }: { label: string, value: number }) {
  return (
    <div className="flex flex-col gap-[var(--sp-0-5)] rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-3)]">
      <span className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</span>
      <span className="font-mono text-[length:var(--text-22)] font-bold text-[var(--text-primary)]">
        {formatNumber(value)}
      </span>
    </div>
  )
}

function TimelineCard({ data, metric, onMetric }: {
  data: ShareNoteAnalytics
  metric: 'views' | 'visitors'
  onMetric: (metric: 'views' | 'visitors') => void
}) {
  const points = data.timeline
  const values = points.map((point) => (metric === 'views' ? point.views : point.visitors))
  const total = values.reduce((sum, value) => sum + value, 0)
  const peak = points.length === 0 ? null : points[values.indexOf(Math.max(...values))]
  const titleId = useId()
  const build = useMemo(() => buildTrendChart(points, metric), [points, metric])
  const label = t('share.reading_trend_chart_aria', {
    metric: metric === 'views' ? t('share.metric_pv') : t('share.metric_uv'),
    total: formatNumber(total),
    peak: formatNumber(peak?.[metric] ?? 0),
    at: peak?.label ?? '',
  })

  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-3)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--sp-2)]">
        <p id={titleId} className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
          {t('share.timeline_trend_title')}
        </p>
        <Segmented
          size="sm"
          aria-labelledby={titleId}
          value={metric}
          onChange={onMetric}
          options={[
            { value: 'views', label: t('share.metric_pv') },
            { value: 'visitors', label: t('share.metric_uv') },
          ]}
        />
      </div>
      {total === 0 ? (
        <p className="py-[var(--sp-4)] text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('share.no_data_yet')}
        </p>
      ) : (
        <div className="pt-[var(--sp-1)]">
          <ChartCanvas<'line'> height="h-44" label={label} build={build} />
        </div>
      )}
    </div>
  )
}

/**
 * The line, memoised on the two things that change its shape.
 *
 * `ChartCanvas` re-runs its effect when `build` is a new function, so a builder that closed over nothing
 * would rebuild the chart on every render of the modal — and one left to the caller's identity would keep
 * an old window on screen after the range changed.
 */
function buildTrendChart(
  points: ShareNoteAnalytics['timeline'],
  metric: 'views' | 'visitors',
): (colors: ChartColors) => ChartConfiguration<'line'> {
  return (colors) => {
    const accent = colors.palette[0] ?? '#888'
    return {
      type: 'line',
      data: {
        labels: points.map((point) => point.label),
        datasets: [{
          data: points.map((point) => (metric === 'views' ? point.views : point.visitors)),
          borderColor: accent,
          backgroundColor: withAlpha(accent, 0.18),
          borderWidth: 2,
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          pointHoverRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { ticks: { color: colors.text, maxTicksLimit: 8 }, grid: { color: colors.grid } },
          y: { beginAtZero: true, ticks: { color: colors.text, precision: 0 }, grid: { color: colors.grid } },
        },
      },
    }
  }
}

/**
 * The six splits, every row the API answered.
 *
 * The server bounds each breakdown itself; slicing again here would be a second, invisible ceiling that
 * reads as "these are the only countries that ever visited".
 */
function BreakdownGrid({ data }: { data: ShareNoteAnalytics }) {
  const cards: Array<{ title: string, items: ShareBreakdownItem[], nameOf: (item: ShareBreakdownItem) => string }> = [
    { title: t('share.top_countries_title'), items: data.topCountries, nameOf: (item) => countryName(item.name) },
    { title: t('share.top_referrers_title'), items: data.topReferrers, nameOf: (item) => item.name },
    { title: t('share.reading_devices_title'), items: data.devices, nameOf: (item) => item.name },
    { title: t('share.reading_os_title'), items: data.osList, nameOf: (item) => item.name },
    { title: t('share.reading_browsers_title'), items: data.browsers, nameOf: (item) => item.name },
    { title: t('share.channel_section_title'), items: data.channels, nameOf: channelItemName },
  ]
  return (
    <div className="grid grid-cols-1 gap-[var(--sp-2)] sm:grid-cols-2">
      {cards.map((card) => (
        <BreakdownCard key={card.title} title={card.title} items={card.items} nameOf={card.nameOf} />
      ))}
    </div>
  )
}

function BreakdownCard({ title, items, nameOf }: {
  title: string
  items: ShareBreakdownItem[]
  nameOf: (item: ShareBreakdownItem) => string
}) {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-3)]">
      <p className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{title}</p>
      {items.length === 0 ? (
        <p className="py-[var(--sp-2)] text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('share.no_data_yet')}
        </p>
      ) : (
        <ul className="space-y-[var(--sp-1-5)] pt-[var(--sp-1-5)]">
          {items.map((item) => <BreakdownRow key={item.name} item={item} nameOf={nameOf} />)}
        </ul>
      )}
    </div>
  )
}

function BreakdownRow({ item, nameOf }: { item: ShareBreakdownItem, nameOf: (item: ShareBreakdownItem) => string }) {
  const percentage = item.percentage ?? 0
  return (
    <li className="flex flex-col gap-[var(--sp-0-5)] text-[length:var(--text-11)]">
      <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
        <span className="min-w-0 truncate text-[var(--text-primary)]">{nameOf(item)}</span>
        <span className="flex shrink-0 items-baseline gap-[var(--sp-1)] font-mono">
          <span className="font-medium text-[var(--text-primary)]">{formatNumber(item.count)}</span>
          <span className="text-[var(--text-quaternary)]">{`${percentage}%`}</span>
        </span>
      </div>
      {/* A proportion has no token of its own and no fixed length: the width is the reading itself. */}
      <div className="h-1 w-full overflow-hidden rounded-[var(--r-full)] bg-[var(--bg-surface)]">
        <div
          className="h-full rounded-[var(--r-full)] bg-[var(--accent)]"
          style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
        />
      </div>
    </li>
  )
}

/**
 * The rows behind the numbers, at the same eight-character ceiling the log prints.
 *
 * A list, not a `div` per row: each line is one visit, and the columns are the columns of the full log —
 * the same facts a reader can page through in the log table are here in a page's worth of them.
 */
function RecentVisitsCard({ data }: { data: ShareNoteAnalytics }) {
  const visits = data.recentVisits
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[var(--sp-3)]">
      <p className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">
        {t('share.recent_activity_title')}
      </p>
      {visits.length === 0 ? (
        <p className="py-[var(--sp-3)] text-center text-[length:var(--text-11)] text-[var(--text-quaternary)]">
          {t('share.no_visits_yet')}
        </p>
      ) : (
        <table className="w-full border-collapse pt-[var(--sp-1)] text-left text-[length:var(--text-11)]">
          <caption className="sr-only">{t('share.recent_activity_title')}</caption>
          <thead className="text-[var(--text-quaternary)]">
            <tr>
              <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_time')}</th>
              <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_place')}</th>
              <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_device')}</th>
              <th scope="col" className="py-[var(--sp-1)] pr-[var(--sp-2)] font-medium">{t('share.reading_col_channel')}</th>
              <th scope="col" className="py-[var(--sp-1)] font-medium">{t('share.reading_col_visitor')}</th>
            </tr>
          </thead>
          <tbody>
            {visits.map((visit) => (
              <tr key={visit.id} className="border-t border-[var(--border-subtle)] align-top">
                <th scope="row" className="py-[var(--sp-1)] pr-[var(--sp-2)] text-left font-normal text-[var(--text-tertiary)]">
                  <time dateTime={new Date(visit.visitedAt).toISOString()} title={fullTime(visit.visitedAt)}>
                    {relativeTime(visit.visitedAt)}
                  </time>
                </th>
                <td className="py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]">
                  {locationLabel(visit)}
                </td>
                <td className="py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]">
                  {deviceLabel(visit)}
                  {visit.isBot ? ` · ${visit.botName || t('share.badge_bot')}` : ''}
                  {visit.isOwner ? ` · ${t('share.badge_owner')}` : ''}
                  {visit.isSelfReferrer ? ` · ${t('share.badge_self_referrer')}` : ''}
                </td>
                <td className="py-[var(--sp-1)] pr-[var(--sp-2)] text-[var(--text-secondary)]">
                  {rowChannelName(visit.channel)}
                </td>
                <td className="py-[var(--sp-1)] font-mono text-[var(--text-quaternary)]">
                  {visitorLabel(visit.visitorFp) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

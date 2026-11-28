/**
 * What was sent, and what the sweep did.
 *
 * The two halves answer different questions and are deliberately on one screen: "did this channel
 * deliver that message" is the delivery log, and "did the sweep run at all" is the schedule log. A
 * reader whose reminders stopped needs the second the moment the first is empty — a page that only
 * listed deliveries would show nothing and explain nothing.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { IconButton, SectionLabel } from '../../components/primitives'
import { Select } from '../../components/form'
import { LoadingBlock } from '../../components/feedback'
import { channelLabelKey } from '@shared/subscriptions/channels'
import { formatLocalDate } from '@shared/subscriptions/time'
import { CHANNEL_KINDS, type ChannelKind, type NotifyLogEntry, type NotifyLogFilter, type ScheduleLogEntry, type SubscriptionItem } from '@shared/subscriptions/model'
import type { SubscriptionLogs } from './store'

const PERIODS = ['today', 'hours72', 'week', 'month', 'all'] as const
const LIMITS = [50, 100, 200, 500] as const
type Period = (typeof PERIODS)[number]

function sinceOf(period: Period): string | undefined {
  if (period === 'all') return undefined
  const hours = period === 'today' ? 24 : period === 'hours72' ? 72 : period === 'week' ? 168 : 720
  return new Date(Date.now() - hours * 3_600_000).toISOString()
}

export function LogsView({
  logs,
  items,
  timezone = 'UTC',
  onLoad,
}: {
  logs: SubscriptionLogs
  items: readonly SubscriptionItem[]
  timezone?: string
  onLoad: (filter: NotifyLogFilter) => void
}): ReactElement {
  const [period, setPeriod] = useState<Period>('week')
  const [channel, setChannel] = useState<ChannelKind | ''>('')
  const [status, setStatus] = useState<'success' | 'failed' | ''>('')
  const [subscriptionId, setSubscriptionId] = useState('')
  const [limit, setLimit] = useState<number>(100)

  const reload = (): void => {
    onLoad({
      since: sinceOf(period),
      limit,
      channel: channel || undefined,
      status: status || undefined,
      subscriptionId: subscriptionId || undefined,
    })
  }

  const apply = (next: { period?: Period; channel?: ChannelKind | ''; status?: 'success' | 'failed' | ''; subscriptionId?: string; limit?: number }): void => {
    const merged = { period, channel, status, subscriptionId, limit, ...next }
    if (next.period !== undefined) setPeriod(next.period)
    if (next.channel !== undefined) setChannel(next.channel)
    if (next.status !== undefined) setStatus(next.status)
    if (next.subscriptionId !== undefined) setSubscriptionId(next.subscriptionId)
    if (next.limit !== undefined) setLimit(next.limit)
    onLoad({
      since: sinceOf(merged.period),
      limit: merged.limit,
      channel: merged.channel || undefined,
      status: merged.status || undefined,
      subscriptionId: merged.subscriptionId || undefined,
    })
  }

  useEffect(() => {
    onLoad({ since: sinceOf('week'), limit: 100 })
  }, [onLoad])

  const success = logs.notify.filter((entry) => entry.status === 'success').length
  const failed = logs.notify.filter((entry) => entry.status === 'failed').length

  return (
    <div className="no-scrollbar h-full overflow-y-auto px-4 pb-8 pt-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Metric label={t('subscriptions.logs.total')} value={String(logs.notify.length)} />
        <Metric label={t('subscriptions.logs.success')} value={String(success)} tone="success" />
        <Metric label={t('subscriptions.logs.failed')} value={String(failed)} tone={failed > 0 ? 'danger' : undefined} />
        <Metric
          label={t('subscriptions.logs.latest')}
          value={logs.notify[0] ? formatLocalDate(logs.notify[0].createdAt, timezone, 'datetime') : '—'}
          small
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Select aria-label={t('subscriptions.logs.filter_period')} value={period} onChange={(event) => apply({ period: event.target.value as Period })} className="h-7 w-[120px] text-[length:var(--text-11-5)]">
          <option value="today">{t('subscriptions.logs.period_today')}</option>
          <option value="hours72">{t('subscriptions.logs.period_72_hours')}</option>
          <option value="week">{t('subscriptions.logs.period_week')}</option>
          <option value="month">{t('subscriptions.logs.period_month')}</option>
          <option value="all">{t('subscriptions.logs.period_all')}</option>
        </Select>
        <Select aria-label={t('subscriptions.logs.filter_channel')} value={channel} onChange={(event) => apply({ channel: event.target.value as ChannelKind | '' })} className="h-7 w-[132px] text-[length:var(--text-11-5)]">
          <option value="">{t('subscriptions.logs.all')}</option>
          {/* The registry of kinds, not a copy of it: the hand-written list here had already fallen behind
              and left the in-app channel unfilterable. */}
          {CHANNEL_KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(channelLabelKey(kind))}</option>
          ))}
        </Select>
        <Select aria-label={t('subscriptions.logs.filter_status')} value={status} onChange={(event) => apply({ status: event.target.value as 'success' | 'failed' | '' })} className="h-7 w-[112px] text-[length:var(--text-11-5)]">
          <option value="">{t('subscriptions.logs.all')}</option>
          <option value="success">{t('subscriptions.logs.status_success')}</option>
          <option value="failed">{t('subscriptions.logs.status_failed')}</option>
        </Select>
        <Select aria-label={t('subscriptions.logs.filter_subscription')} value={subscriptionId} onChange={(event) => apply({ subscriptionId: event.target.value })} className="h-7 max-w-[180px] text-[length:var(--text-11-5)]">
          <option value="">{t('subscriptions.logs.all')}</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <Select aria-label={t('subscriptions.logs.filter_limit')} value={limit} onChange={(event) => apply({ limit: Number(event.target.value) })} className="h-7 w-[96px] text-[length:var(--text-11-5)]">
          {LIMITS.map((value) => <option key={value} value={value}>{value}</option>)}
        </Select>
        <IconButton label={t('subscriptions.logs.refresh')} size="sm" onClick={reload} className="ml-auto">
          <RefreshCw size={14} />
        </IconButton>
      </div>

      {logs.loading
        ? <LoadingBlock label={t('subscriptions.loading')} />
        : logs.error
          ? <p className="mt-4 text-[length:var(--text-12)] text-[var(--danger)]">{logs.error}</p>
          : logs.notify.length === 0
            ? <p className="mt-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.logs.empty')}</p>
            : (
                <ul className="mt-2 divide-y divide-[var(--border-subtle)]">
                  {logs.notify.map((entry) => <LogRow key={entry.id} entry={entry} timezone={timezone} />)}
                </ul>
              )}

      <section className="mt-4">
        <SectionLabel>{t('subscriptions.logs.schedule')}</SectionLabel>
        {logs.schedule.length === 0
          ? <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('subscriptions.overview.scheduler_never')}</p>
          : (
              <ul className="mt-1.5 space-y-1">
                {logs.schedule.map((entry) => <ScheduleRow key={entry.id} entry={entry} timezone={timezone} />)}
              </ul>
            )}
      </section>
    </div>
  )
}

function Metric({ label, value, tone, small }: { label: string; value: string; tone?: 'success' | 'danger'; small?: boolean }): ReactElement {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2">
      <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">{label}</p>
      <p
        className={cn(
          'mt-0.5 tabular-nums',
          small ? 'text-[length:var(--text-11-5)]' : 'text-[length:var(--text-20)] font-semibold',
          tone === 'success' ? 'text-[var(--success)]' : tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

function LogRow({ entry, timezone }: { entry: NotifyLogEntry; timezone: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <li className="py-1.5">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-1 py-1 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', entry.status === 'success' ? 'bg-[var(--success)]' : 'bg-[var(--danger)]')}
        />
        {/* The dot is the only visible difference between a delivery that worked and one that did not, and
            a colour with no name behind it reads as nothing at all to a screen reader. */}
        <span className="sr-only">
          {t(entry.status === 'success' ? 'subscriptions.logs.status_success' : 'subscriptions.logs.status_failed')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
          {entry.subscriptionName || entry.title}
        </span>
        <span className="shrink-0 text-[length:var(--text-11)] text-[var(--text-tertiary)]">{t(channelLabelKey(entry.channel))}</span>
        <span className="shrink-0 text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{formatLocalDate(entry.createdAt, timezone, 'datetime')}</span>
        <ChevronDown size={13} aria-hidden="true" className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2">
          <dl className="grid gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:grid-cols-2">
            <div className="flex gap-1.5 break-all"><dt>{t('subscriptions.logs.rule_id')}:</dt><dd className="font-mono text-[var(--text-secondary)]">{entry.ruleId}</dd></div>
            <div className="flex gap-1.5 break-all"><dt>{t('subscriptions.logs.subscription_id')}:</dt><dd className="font-mono text-[var(--text-secondary)]">{entry.subscriptionId}</dd></div>
            <div className="flex gap-1.5 sm:col-span-2"><dt>{t('subscriptions.logs.title')}:</dt><dd className="min-w-0 break-words text-[var(--text-secondary)]">{entry.title}</dd></div>
          </dl>
          {entry.error && <p className="text-[length:var(--text-11-5)] text-[var(--danger)]">{t('subscriptions.logs.error')}: {entry.error}</p>}
          <p className="whitespace-pre-wrap break-words text-[length:var(--text-11)] leading-relaxed text-[var(--text-secondary)]">{entry.body}</p>
          {entry.detail && <p className="break-words text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('subscriptions.logs.detail')}: {entry.detail}</p>}
        </div>
      )}
    </li>
  )
}

function ScheduleRow({ entry, timezone }: { entry: ScheduleLogEntry; timezone: string }): ReactElement {
  const [open, setOpen] = useState(false)
  const label = entry.status === 'error' ? 'subscriptions.logs.sched_error' : entry.status === 'skipped' ? 'subscriptions.logs.sched_skipped' : 'subscriptions.logs.sched_ok'
  return (
    <li className="rounded-[var(--r-md)] px-1 py-1 text-[length:var(--text-11)] hover:bg-[var(--bg-hover)]">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[var(--r-sm)] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 text-[length:var(--text-10)]',
            entry.status === 'error'
              ? 'bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] text-[var(--danger)]'
              : entry.status === 'skipped'
                ? 'bg-[var(--bg-inset)] text-[var(--text-quaternary)]'
                : 'bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)]',
          )}
        >
          {t(label)}
        </span>
        <span className="shrink-0 tabular-nums text-[var(--text-quaternary)]">{formatLocalDate(entry.startedAt, timezone, 'datetime')}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{entry.reason}</span>
        <span className="shrink-0 tabular-nums text-[var(--text-quaternary)]">
          {t('subscriptions.overview.scheduler_counts', {
            checked: entry.checkedCount,
            matched: entry.matchedCount,
            deduped: entry.dedupedCount,
            sent: entry.sentCount,
            renewed: entry.renewedCount,
          })}
        </span>
        <ChevronDown size={13} aria-hidden="true" className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <dl className="mt-1 grid gap-1 rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2.5 py-2 text-[length:var(--text-10-5)] text-[var(--text-tertiary)] sm:grid-cols-2">
          <div className="flex gap-1.5"><dt>{t('subscriptions.logs.schedule_timezone')}:</dt><dd className="font-mono text-[var(--text-secondary)]">{entry.timezone}</dd></div>
          <div className="flex gap-1.5"><dt>{t('subscriptions.logs.schedule_hour')}:</dt><dd className="tabular-nums text-[var(--text-secondary)]">{entry.hour}</dd></div>
          <div className="flex gap-1.5"><dt>{t('subscriptions.logs.schedule_hours')}:</dt><dd className="break-words text-[var(--text-secondary)]">{entry.hours.join(', ') || '—'}</dd></div>
          <div className="flex gap-1.5"><dt>{t('subscriptions.logs.schedule_window')}:</dt><dd className="text-[var(--text-secondary)]">{t(entry.inWindow ? 'subscriptions.overview.scheduler_window' : 'subscriptions.overview.scheduler_outside')}</dd></div>
          <div className="flex gap-1.5 sm:col-span-2"><dt>{t('subscriptions.logs.schedule_finished')}:</dt><dd className="tabular-nums text-[var(--text-secondary)]">{formatLocalDate(entry.finishedAt, timezone, 'datetime')}</dd></div>
          {entry.detail && <div className="flex gap-1.5 sm:col-span-2"><dt>{t('subscriptions.logs.schedule_detail')}:</dt><dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{entry.detail}</dd></div>}
        </dl>
      )}
    </li>
  )
}

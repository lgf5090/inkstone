/**
 * The dashboard: what this costs, what is about to renew, and whether the reminders are running.
 *
 * The four cards answer the questions a reader opens the app with, in the order they ask them. The bar
 * chart is six months of receipts rather than a projection, because a subscription app's whole value is
 * knowing what was actually charged. Every bar is a plain box with a height — a charting library would
 * be a second rendering stack for six rectangles, and it would draw on a canvas a screen reader cannot
 * read.
 */
import type { ReactElement } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { formatAmount } from '@shared/subscriptions/format'
import type { SubscriptionOverview } from '@shared/subscriptions/model'

export function OverviewView({
  overview,
  loading,
  currency,
  onOpenItem,
  onOpenLogs,
  onAdd,
}: {
  overview: SubscriptionOverview | null
  loading: boolean
  currency: string
  onOpenItem: (id: string) => void
  onOpenLogs: () => void
  onAdd: () => void
}): ReactElement {
  if (loading || !overview) return <LoadingBlock label={t('subscriptions.loading')} />
  if (overview.active.total === 0) {
    return (
      <Empty
        art="subscriptions"
        title={t('subscriptions.overview.empty')}
        description={t('subscriptions.overview.empty_hint')}
        action={<Button variant="primary" onClick={onAdd}>{t('subscriptions.add')}</Button>}
      />
    )
  }

  const peak = Math.max(1, ...overview.months.map((month) => month.amount))
  const trend = overview.monthly
  const TrendIcon = trend.direction === 'up' ? ArrowUpRight : trend.direction === 'down' ? ArrowDownRight : Minus

  return (
    <div className="no-scrollbar h-full overflow-y-auto px-4 pb-8 pt-3">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard
          label={t('subscriptions.overview.monthly')}
          value={formatAmount(overview.monthly.amount, currency)}
          footer={(
            <span className={cn('inline-flex items-center gap-0.5', trend.direction === 'up' ? 'text-[var(--danger)]' : trend.direction === 'down' ? 'text-[var(--success)]' : 'text-[var(--text-quaternary)]')}>
              <TrendIcon size={12} aria-hidden="true" />
              {trend.direction === 'flat'
                ? t('subscriptions.overview.trend_flat')
                : t(trend.direction === 'up' ? 'subscriptions.overview.trend_up' : 'subscriptions.overview.trend_down', { value: trend.trend })}
            </span>
          )}
        />
        <StatCard
          label={t('subscriptions.overview.yearly')}
          value={formatAmount(overview.yearly.amount, currency)}
          footer={<span className="text-[var(--text-quaternary)]">{t('subscriptions.overview.monthly_average', { amount: formatAmount(overview.yearly.monthlyAverage, currency) })}</span>}
        />
        <StatCard
          label={t('subscriptions.overview.active')}
          value={t('subscriptions.overview.active_detail', { active: overview.active.active, total: overview.active.total })}
        />
        <StatCard
          label={t('subscriptions.overview.expiring')}
          value={String(overview.active.expiringSoon)}
          tone={overview.active.expiringSoon > 0 ? 'warning' : undefined}
        />
      </div>

      <Card className="mt-3">
        <CardTitle>{t('subscriptions.overview.trend_title')}</CardTitle>
        <div className="mt-3 flex h-24 items-end gap-1.5" role="img" aria-label={t('subscriptions.overview.trend_title')}>
          {overview.months.map((month, index) => (
            <div key={month.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex h-full w-full items-end">
                <div
                  className={cn(
                    'w-full rounded-t-[var(--r-xs)]',
                    index === overview.months.length - 1 ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_oklab,var(--accent)_42%,transparent)]',
                  )}
                  style={{ height: `${Math.max(2, Math.round((month.amount / peak) * 100))}%` }}
                  title={formatAmount(month.amount, currency)}
                />
              </div>
              <span className="text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]">{month.month.slice(5)}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardTitle>{t('subscriptions.overview.upcoming')}</CardTitle>
          {overview.upcoming.length === 0
            ? <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.overview.no_upcoming')}</p>
            : (
                <ul className="mt-2 space-y-0.5">
                  {overview.upcoming.slice(0, 5).map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => onOpenItem(entry.id)}
                        className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-1.5 py-1.5 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                        <span className="shrink-0 text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">{formatAmount(entry.amount, entry.currency)}</span>
                        <span className="w-16 shrink-0 text-right text-[length:var(--text-11)] tabular-nums text-[var(--warning)]">
                          {t('subscriptions.status.days_left', { count: entry.daysUntilRenewal })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.by_category')}</CardTitle>
          <ShareBars
            shares={overview.byCategory.slice(0, 5)}
            emptyLabel={t('subscriptions.overview.no_spending')}
            currency={currency}
          />
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.by_type')}</CardTitle>
          <ShareBars
            shares={overview.byType.slice(0, 5)}
            emptyLabel={t('subscriptions.overview.no_spending')}
            currency={currency}
          />
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.scheduler')}</CardTitle>
          {overview.scheduler
            ? (
                <div className="mt-2 space-y-1">
                  <p className="text-[length:var(--text-12)] text-[var(--text-secondary)]">
                    {overview.scheduler.inWindow ? t('subscriptions.overview.scheduler_window') : t('subscriptions.overview.scheduler_outside')}
                  </p>
                  <p className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
                    {t('subscriptions.overview.scheduler_counts', {
                      checked: overview.scheduler.checkedCount,
                      matched: overview.scheduler.matchedCount,
                      deduped: overview.scheduler.dedupedCount,
                      sent: overview.scheduler.sentCount,
                      renewed: overview.scheduler.renewedCount,
                    })}
                  </p>
                  <p className="text-[length:var(--text-11)] text-[var(--text-quaternary)]">{overview.scheduler.startedAt.slice(0, 16).replace('T', ' ')}</p>
                </div>
              )
            : <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.overview.scheduler_never')}</p>}
          <Button size="sm" variant="ghost" className="mt-2 -ml-2 text-[var(--accent)]" onClick={onOpenLogs}>
            {t('subscriptions.view.logs')}
          </Button>
        </Card>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  footer,
  tone,
}: {
  label: string
  value: string
  footer?: ReactElement
  tone?: 'warning'
}): ReactElement {
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5">
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</p>
      <p className={cn('mt-1 text-[length:var(--text-20)] font-semibold tabular-nums', tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]')}>
        {value}
      </p>
      {footer && <p className="mt-1 text-[length:var(--text-11)]">{footer}</p>}
    </div>
  )
}

function ShareBars({
  shares,
  emptyLabel,
  currency,
}: {
  shares: SubscriptionOverview['byCategory']
  emptyLabel: string
  currency: string
}): ReactElement {
  if (shares.length === 0) return <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{emptyLabel}</p>
  return (
    <ul className="mt-2 space-y-1.5">
      {shares.map((share) => (
        <li key={share.label}>
          <div className="flex items-baseline justify-between gap-2 text-[length:var(--text-11-5)]">
            <span className="min-w-0 truncate text-[var(--text-secondary)]">
              {share.label === 'uncategorized' ? t('subscriptions.detail.uncategorized') : share.label === 'other' ? t('subscriptions.overview.other_type') : share.label}
            </span>
            <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">{formatAmount(share.amount, currency)} · {share.percentage}%</span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, share.percentage)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Card({ children, className }: { children: ReactElement | ReactElement[]; className?: string }): ReactElement {
  return (
    <div className={cn('rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3', className)}>
      {children}
    </div>
  )
}

function CardTitle({ children }: { children: string }): ReactElement {
  return <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{children}</h2>
}

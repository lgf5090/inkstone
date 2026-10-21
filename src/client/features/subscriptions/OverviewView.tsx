/**
 * The dashboard: what this costs, what is about to renew, and whether the reminders are running.
 *
 * The four cards answer the questions a reader opens the app with, in the order they ask them. The bar
 * chart is six months of receipts rather than a projection, because a subscription app's whole value is
 * knowing what was actually charged. Every bar is a plain box with a height — a charting library would
 * be a second rendering stack for six rectangles, and it would draw on a canvas a screen reader cannot
 * read.
 */
import type { ReactElement, ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { formatAmount } from '@shared/subscriptions/format'
import { formatLocalDate } from '@shared/subscriptions/time'
import type { LabelKind, SubscriptionOverview } from '@shared/subscriptions/model'
import { iconComponentOf } from './label-icons'
import { CurrencyFlag } from './currency-flag'
import { useLabelIdentity } from './label-identity'

/**
 * The tallest bar, in pixels.
 *
 * Bar heights are written out in px against this number rather than as a percentage of the plot: the
 * column also holds its month label, so it is sized by its content, and a percentage height resolving
 * against a content-sized parent is zero — which drew six labels and no chart.
 */
const PLOT_HEIGHT = 96

/**
 * A month with no receipts draws nothing.
 *
 * The first version gave it a two-pixel stub so the six columns would read as one series; in the real
 * layout five stubs joined into a line along the baseline, which looks exactly like an axis saying the
 * spending was merely small. The month label below it already keeps the series legible.
 */
function barHeight(amount: number, peak: number): string {
  return `${amount > 0 ? Math.max(2, Math.round((amount / peak) * PLOT_HEIGHT)) : 0}px`
}

/**
 * Where the money's numbers came from.
 *
 * Every total above is one currency's sum of converted amounts, so the screen owes the reader three
 * facts: which currency it added up in, whose rates it used and how old they are, and which of the
 * account's own currencies had no rate at all and so sit in none of those totals. A reader who asks "is
 * this live?" has to be answerable by looking, not by reading the code.
 */
function RatesStrip({ rates, timezone, refreshing, onRefresh }: {
  rates: SubscriptionOverview['rates']
  timezone: string
  refreshing: boolean
  onRefresh: () => void
}): ReactElement {
  const unpriced = rates.unpriced.length > 0
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--text-11)] text-[var(--text-tertiary)]">
        <span>{t(rates.source === 'feed' ? 'subscriptions.overview.rates_feed' : 'subscriptions.overview.rates_approximate')}</span>
        {rates.at !== null && (
          <span>{t('subscriptions.overview.rates_taken', { when: formatLocalDate(rates.at, timezone, 'date') })}</span>
        )}
        <span className="inline-flex items-center gap-1">
          <CurrencyFlag code={rates.base} />
          {t('subscriptions.overview.rates_base', { code: rates.base })}
        </span>
        {rates.pinned.length > 0 && (
          <span>{t('subscriptions.overview.rates_pinned', { codes: rates.pinned.join(', ') })}</span>
        )}
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={onRefresh}>
          {t('subscriptions.overview.rates_refresh')}
        </Button>
      </div>
      {(unpriced || !rates.basePriced) && (
        <p className="mt-1 text-[length:var(--text-11)] leading-relaxed text-[var(--warning)]">
          {unpriced && <span>{t('subscriptions.overview.rates_unpriced', { codes: rates.unpriced.join(', ') })}</span>}
          {!rates.basePriced && (
            <span className={unpriced ? 'ml-2' : undefined}>
              {t('subscriptions.overview.rates_base_unpriced', { code: rates.base })}
            </span>
          )}
        </p>
      )}
    </div>
  )
}

export function OverviewView({
  overview,
  loading,
  currency,
  refreshingRates,
  onRefreshRates,
  onOpenItem,
  onOpenLogs,
  onAdd,
}: {
  overview: SubscriptionOverview | null
  loading: boolean
  currency: string
  refreshingRates: boolean
  onRefreshRates: () => void
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
          tone={overview.budget.over ? 'danger' : undefined}
          footer={(
            <span className={cn('inline-flex items-center gap-0.5', trend.direction === 'up' ? 'text-[var(--danger)]' : trend.direction === 'down' ? 'text-[var(--success)]' : 'text-[var(--text-quaternary)]')}>
              <TrendIcon size={12} aria-hidden="true" />
              {trend.direction === 'flat'
                ? t('subscriptions.overview.trend_flat')
                : t(trend.direction === 'up' ? 'subscriptions.overview.trend_up' : 'subscriptions.overview.trend_down', { value: trend.trend })}
              {overview.budget.limit !== null && (
                <span className={cn('ml-1.5', overview.budget.over ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>
                  / {formatAmount(overview.budget.limit, currency)}
                </span>
              )}
            </span>
          )}
        />
        <StatCard
          label={t('subscriptions.overview.yearly')}
          value={formatAmount(overview.yearly.amount, currency)}
          tone={overview.yearlyBudget.over ? 'danger' : undefined}
          footer={(
            <span className="block space-y-0.5">
              <span className="block text-[var(--text-quaternary)]">
                {t('subscriptions.overview.monthly_average', { amount: formatAmount(overview.yearly.monthlyAverage, currency) })}
                {overview.yearlyBudget.limit !== null && (
                  <span className={cn('ml-1.5', overview.yearlyBudget.over ? 'text-[var(--danger)]' : '')}>
                    / {formatAmount(overview.yearlyBudget.limit, currency)}
                  </span>
                )}
              </span>
              {overview.yearlyBudget.perMonthLeft !== null && (
                <span className="block text-[var(--text-quaternary)]">
                  {t('subscriptions.overview.yearly_pace', { amount: formatAmount(overview.yearlyBudget.perMonthLeft, currency) })}
                </span>
              )}
              {overview.yearlyBudget.over && (
                <span className="block text-[var(--danger)]">{t('subscriptions.overview.yearly_over')}</span>
              )}
            </span>
          )}
        />
        {/* Spent this year and committed for the next are different questions, and only one of them is
            answered by the receipts. A plan cancelled tomorrow stops counting here, not there. */}
        <StatCard
          label={t('subscriptions.overview.committed')}
          value={formatAmount(overview.committedYearly, currency)}
          footer={<span className="text-[var(--text-quaternary)]">{t('subscriptions.overview.committed_hint')}</span>}
        />
        <StatCard
          label={t('subscriptions.overview.active')}
          value={t('subscriptions.overview.active_detail', { active: overview.active.active, total: overview.active.total })}
          footer={overview.active.expiringSoon > 0
            ? <span className="text-[var(--warning)]">{t('subscriptions.overview.expiring_detail', { count: overview.active.expiringSoon })}</span>
            : <span className="text-[var(--text-quaternary)]">{t('subscriptions.overview.no_expiring')}</span>}
        />
      </div>

      <RatesStrip
        rates={overview.rates}
        timezone={overview.timezone}
        refreshing={refreshingRates}
        onRefresh={onRefreshRates}
      />

      <Card className="mt-3">
        <CardTitle>{t('subscriptions.overview.trend_title')}</CardTitle>
        <div className="mt-3 flex items-end gap-1.5" role="img" aria-label={t('subscriptions.overview.trend_title')}>
          {overview.months.map((month, index) => (
            <div key={month.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex w-full items-end" style={{ height: PLOT_HEIGHT }}>
                <div
                  className={cn(
                    'w-full rounded-t-[var(--r-xs)]',
                    index === overview.months.length - 1 ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_oklab,var(--accent)_42%,transparent)]',
                  )}
                  style={{ height: barHeight(month.amount, peak) }}
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
          {/* The other half of "what is about to happen": what already did. A reader reconciling a bank
              statement looks here first, and the worker had been computing this into every bundle
              without anything ever drawing it. */}
          <CardTitle>{t('subscriptions.overview.recent_payments')}</CardTitle>
          {overview.recentPayments.length === 0
            ? <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.overview.no_recent_payments')}</p>
            : (
                <ul className="mt-2 space-y-0.5">
                  {overview.recentPayments.slice(0, 5).map((entry) => (
                    <li key={`${entry.paymentDate}:${entry.name}`} className="flex items-center gap-2 px-1.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{entry.name}</span>
                      <span className="shrink-0 text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">{formatAmount(entry.amount, entry.currency)}</span>
                      <span className="w-20 shrink-0 text-right text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{entry.paymentDate.slice(5, 10)}</span>
                    </li>
                  ))}
                </ul>
              )}
        </Card>

        <Card>
          {/* A trial is the one subscription that turns into a bill without anyone deciding to buy
              anything, which makes it the most useful thing on this page to be told about. */}
          <CardTitle>{t('subscriptions.overview.trials')}</CardTitle>
          {overview.trials.length === 0
            ? <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.overview.no_trials')}</p>
            : (
                <ul className="mt-2 space-y-0.5">
                  {overview.trials.slice(0, 5).map((trial) => (
                    <li key={trial.id}>
                      <button
                        type="button"
                        onClick={() => onOpenItem(trial.id)}
                        className="flex w-full items-center gap-2 rounded-[var(--r-md)] px-1.5 py-1.5 text-left hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                      >
                        <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{trial.name}</span>
                        <span className="shrink-0 text-[length:var(--text-12)] tabular-nums text-[var(--text-secondary)]">{formatAmount(trial.amount, trial.currency)}</span>
                        <span className="w-20 shrink-0 text-right text-[length:var(--text-11)] tabular-nums text-[var(--warning)]">
                          {t('subscriptions.status.days_left', { count: trial.daysRemaining })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </Card>

        <Card>
          {/* Read out of the receipts, because `amount` is what a plan costs now and a rise that happened
              in March would otherwise leave the January figure and the memory of the old price both intact. */}
          <CardTitle>{t('subscriptions.overview.price_changes')}</CardTitle>
          {overview.priceChanges.length === 0
            ? <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('subscriptions.overview.no_price_changes')}</p>
            : (
                <ul className="mt-2 space-y-1">
                  {overview.priceChanges.slice(0, 5).map((change) => (
                    <li key={change.id} className="flex items-baseline justify-between gap-2 px-1.5 text-[length:var(--text-11-5)]">
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{change.name}</span>
                      <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
                        {formatAmount(change.previous, change.currency)} → {formatAmount(change.current, change.currency)}
                      </span>
                      <span className={cn('w-12 shrink-0 text-right tabular-nums', change.change > 0 ? 'text-[var(--danger)]' : 'text-[var(--success)]')}>
                        {change.change > 0 ? '+' : ''}{change.change}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.by_category')}</CardTitle>
          <ShareBars
            shares={overview.byCategory.slice(0, 5)}
            kind="category"
            emptyLabel={t('subscriptions.overview.no_spending')}
            currency={currency}
          />
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.by_type')}</CardTitle>
          <ShareBars
            shares={overview.byType.slice(0, 5)}
            kind="type"
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
          {/* The last few runs, not just the last one. "It did not send today" and "it has not sent in a
              week" are different problems, and the second one is only visible if the history is. */}
          {overview.history.length > 1 && (
            <ul className="mt-2 space-y-0.5 border-t border-[var(--border-subtle)] pt-2">
              {overview.history.slice(1, 6).map((entry) => (
                <li key={entry.id} className="flex items-baseline gap-2 text-[length:var(--text-11)]">
                  <span
                    className={cn(
                      'shrink-0',
                      entry.status === 'error' ? 'text-[var(--danger)]' : entry.status === 'skipped' ? 'text-[var(--text-quaternary)]' : 'text-[var(--success)]',
                    )}
                    aria-hidden="true"
                  >
                    ●
                  </span>
                  <span className="shrink-0 tabular-nums text-[var(--text-quaternary)]">{entry.startedAt.slice(5, 16).replace('T', ' ')}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{entry.reason}</span>
                </li>
              ))}
            </ul>
          )}
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
  tone?: 'warning' | 'danger'
}): ReactElement {
  const toneClass = tone === 'warning'
    ? 'text-[var(--warning)]'
    : tone === 'danger'
      ? 'text-[var(--danger)]'
      : 'text-[var(--text-primary)]'
  return (
    <div className="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5">
      <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{label}</p>
      <p className={cn('mt-1 text-[length:var(--text-20)] font-semibold tabular-nums', toneClass)}>
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
  kind,
}: {
  shares: SubscriptionOverview['byCategory']
  emptyLabel: string
  currency: string
  kind: LabelKind
}): ReactElement {
  const identityOf = useLabelIdentity()
  if (shares.length === 0) return <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{emptyLabel}</p>
  return (
    <ul className="mt-2 space-y-1.5">
      {shares.map((share) => {
        // The two sentinels are not labels anybody chose, so they keep the accent rather than being
        // hashed into a colour that would read as a decision about them.
        const chosen = share.label !== 'uncategorized' && share.label !== 'other'
        const identity = chosen ? identityOf(kind, share.label) : null
        const Icon = identity ? iconComponentOf(identity.icon) : null
        const color = identity?.color ?? 'var(--accent)'
        return (
          <li key={share.label}>
            <div className="flex items-baseline justify-between gap-2 text-[length:var(--text-11-5)]">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-[var(--text-secondary)]">
                {Icon && <span aria-hidden="true" className="inline-flex shrink-0" style={{ color }}><Icon size={11} /></span>}
                <span className="truncate">
                  {share.label === 'uncategorized' ? t('subscriptions.detail.uncategorized') : share.label === 'other' ? t('subscriptions.overview.other_type') : share.label}
                </span>
              </span>
              <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">{formatAmount(share.amount, currency)} · {share.percentage}%</span>
            </div>
            <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, share.percentage)}%`, background: color }} />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Card({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return (
    <div className={cn('rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3', className)}>
      {children}
    </div>
  )
}

function CardTitle({ children }: { children: string }): ReactElement {
  return <h2 className="text-[length:var(--text-12)] font-semibold text-[var(--text-primary)]">{children}</h2>
}

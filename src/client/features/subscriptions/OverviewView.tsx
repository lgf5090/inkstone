/**
 * The dashboard: what this costs, what is about to renew, and whether the reminders are running.
 *
 * The four cards answer the questions a reader opens the app with, in the order they ask them. The month
 * chart is twelve months of receipts rather than a projection, because a subscription app's whole value is
 * knowing what was actually charged; it is still drawn as boxes, because six — now twelve — rectangles do
 * not need a second rendering stack, and a row of boxes keeps its numbers legible to a screen reader
 * without a label written by hand.
 *
 * The two share charts are the exception: an arc is not a box. They come through the same chart.js canvas
 * the usage screen and the note charts already use, and each one sits above the list of the same numbers,
 * which is both the reading a canvas cannot offer and the legend the slices are coloured to match.
 */
import type { ReactElement, ReactNode } from 'react'
import { useMemo } from 'react'
import type { ChartConfiguration } from 'chart.js'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { ChartCanvas, type ChartColors } from '../../components/chart-canvas'
import { formatAmount } from '@shared/subscriptions/format'
import { formatLocalDate } from '@shared/subscriptions/time'
import type { ExpenseShare, LabelKind, SubscriptionOverview } from '@shared/subscriptions/model'
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
        <TrendChart months={overview.months} currency={currency} budget={overview.budget.limit} />
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
            shares={overview.byCategory.slice(0, 8)}
            kind="category"
            emptyLabel={t('subscriptions.overview.no_spending')}
            currency={currency}
            chartLabel={t('subscriptions.overview.by_category')}
          />
          {/* Listed beside the shares rather than folded into them: a ceiling on a category that spends
              little is exactly the one a reader wants to see, and it would never reach the top five. */}
          {overview.categoryBudgets.length > 0 && (
            <div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">
              <p className="text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                {t('subscriptions.overview.category_ceilings')}
              </p>
              <ul className="mt-1 space-y-1" data-category-ceilings="">
                {overview.categoryBudgets.map((budget) => (
                  <li key={budget.label} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{budget.label}</span>
                    <span
                      className={cn(
                        'shrink-0 text-[length:var(--text-11-5)] tabular-nums',
                        budget.over ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]',
                      )}
                    >
                      {formatAmount(budget.amount, currency)} / {formatAmount(budget.limit, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardTitle>{t('subscriptions.overview.by_type')}</CardTitle>
          <ShareBars
            shares={overview.byType.slice(0, 8)}
            kind="type"
            emptyLabel={t('subscriptions.overview.no_spending')}
            currency={currency}
            chartLabel={t('subscriptions.overview.by_type')}
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

/**
 * Twelve months of receipts as boxes, with the month's ceiling ruled across them.
 *
 * The line is the reason this chart exists: a bar that reaches past it is the month to look at, and
 * without the line the reader is comparing bar to bar rather than bar to the number they chose. The peak
 * therefore includes the ceiling, so a year that never reached it still shows where it stood. A month
 * that passed the ceiling is drawn in the danger colour rather than only marked, because the shape of the
 * series is what the eye reads first.
 *
 * The boxes are hidden from a screen reader and the same twelve figures are listed beside them: a row of
 * heights carries no numbers to a reader who cannot see them, and one long label written for the whole
 * group would be a second copy of the data to keep in step.
 */
function TrendChart({ months, currency, budget }: {
  months: SubscriptionOverview['months']
  currency: string
  budget: number | null
}): ReactElement {
  const ceiling = budget !== null && budget > 0 ? budget : null
  const peak = Math.max(1, ...months.map((month) => month.amount), ceiling ?? 0)
  return (
    <div className="mt-3">
      <div className="relative" aria-hidden="true">
        {ceiling !== null && (
          <div className="absolute inset-x-0 border-t border-dashed border-[var(--warning)]" style={{ bottom: barHeight(ceiling, peak) }} data-trend-budget="">
            <span className="absolute -top-3.5 right-0 text-[length:var(--text-10)] tabular-nums text-[var(--warning)]">
              {formatAmount(ceiling, currency)}
            </span>
          </div>
        )}
        <div className="flex items-end gap-1" style={{ height: PLOT_HEIGHT }} data-trend-bars="">
          {months.map((month, index) => (
            <div
              key={month.month}
              // One colour per month, chosen rather than layered: two background utilities in the same
              // class string resolve by stylesheet order, which is not an order this file can promise.
              className={cn(
                'min-w-0 flex-1 rounded-t-[var(--r-xs)]',
                ceiling !== null && month.amount > ceiling
                  ? 'bg-[color-mix(in_oklab,var(--danger)_72%,transparent)]'
                  : index === months.length - 1
                    ? 'bg-[var(--accent)]'
                    : 'bg-[color-mix(in_oklab,var(--accent)_42%,transparent)]',
              )}
              style={{ height: barHeight(month.amount, peak) }}
              title={`${month.month} ${formatAmount(month.amount, currency)}`}
            />
          ))}
        </div>
      </div>
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {months.map((month) => (
          <span key={month.month} className="min-w-0 flex-1 text-center text-[length:var(--text-10)] tabular-nums text-[var(--text-quaternary)]">
            {month.month.slice(5)}
          </span>
        ))}
      </div>
      <ul className="sr-only" data-trend-values="">
        {months.map((month) => (
          <li key={month.month}>
            {month.month} · {formatAmount(month.amount, currency)}
            {ceiling !== null && month.amount > ceiling ? ` · ${t('subscriptions.overview.trend_over')}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One share's face: the words and the colour the list row draws.
 *
 * The doughnut and the list under it are the same numbers, so they are named and coloured from here — a
 * slice whose colour came from a second lookup would be free to disagree with the row that names it.
 */
function shareFace(identityOf: ReturnType<typeof useLabelIdentity>, kind: LabelKind, label: string) {
  // The two sentinels are not labels anybody chose, so they keep the accent rather than being hashed into
  // a colour that would read as a decision about them.
  const chosen = label !== 'uncategorized' && label !== 'other'
  const identity = chosen ? identityOf(kind, label) : null
  return {
    color: identity?.color ?? '',
    name: label === 'uncategorized'
      ? t('subscriptions.detail.uncategorized')
      : label === 'other' ? t('subscriptions.overview.other_type') : label,
    Icon: identity ? iconComponentOf(identity.icon) : null,
  }
}

/**
 * The same shares as a ring.
 *
 * Chart.js rather than boxes: an arc is not something to draw with divs, and the library the note charts
 * and the usage screen already load is here for exactly this. No legend — the list below is the legend, in
 * the same order and the same colours — and no numbers hidden in the picture either, because they are all
 * written out under it.
 */
function ShareDoughnut({ shares, currency, kind, label }: {
  shares: readonly ExpenseShare[]
  currency: string
  kind: LabelKind
  label: string
}): ReactElement {
  const identityOf = useLabelIdentity()
  const faces = shares.map((share) => shareFace(identityOf, kind, share.label))
  // The chart rebuilds when a number or a colour moves, not when the dashboard re-renders: a fresh
  // `build` each render would tear the canvas down on every keystroke elsewhere on the page.
  const signature = `${kind}|${shares.map((share, index) => `${share.label}:${share.amount}:${faces[index]!.color}`).join('|')}`
  const build = useMemo(() => (colors: ChartColors): ChartConfiguration<'doughnut'> => ({
    type: 'doughnut',
    data: {
      labels: faces.map((face) => face.name),
      datasets: [{
        data: shares.map((share) => share.amount),
        // A label with no colour of its own — the two sentinels — takes the accent, which is entry zero
        // of the same palette the list row resolves `var(--accent)` from.
        backgroundColor: faces.map((face) => face.color || colors.palette[0]),
        borderWidth: 0,
        hoverOffset: 3,
      }],
    },
    options: {
      cutout: '62%',
      maintainAspectRatio: false,
      // A reader who asked the system to reduce motion gets a ring that appears rather than one that spins.
      animation: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const face = faces[item.dataIndex]
              const share = shares[item.dataIndex]
              if (!face || !share) return ''
              return ` ${face.name} ${formatAmount(share.amount, currency)} · ${share.percentage}%`
            },
          },
        },
      },
    },
  }), [signature, currency])
  return <div className="h-32 mt-2" data-share-ring=""><ChartCanvas height="h-full" label={label} build={build} /></div>
}

function ShareBars({
  shares,
  emptyLabel,
  currency,
  kind,
  chartLabel,
}: {
  shares: SubscriptionOverview['byCategory']
  emptyLabel: string
  currency: string
  kind: LabelKind
  /** What the ring is a picture of, for the reader who cannot see it. */
  chartLabel: string
}): ReactElement {
  const identityOf = useLabelIdentity()
  if (shares.length === 0) return <p className="mt-2 text-[length:var(--text-12)] text-[var(--text-quaternary)]">{emptyLabel}</p>
  return (
    <>
      {/* One slice is not a proportion, it is the whole thing, and the number under it already says so. */}
      {shares.length > 1 && <ShareDoughnut shares={shares} currency={currency} kind={kind} label={chartLabel} />}
      <ul className={cn('space-y-1.5', shares.length > 1 && 'mt-2')} data-share-list="">
        {shares.map((share) => {
          const face = shareFace(identityOf, kind, share.label)
          const color = face.color || 'var(--accent)'
          const Icon = face.Icon
          return (
            <li key={share.label}>
              <div className="flex items-baseline justify-between gap-2 text-[length:var(--text-11-5)]">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[var(--text-secondary)]">
                  {Icon && <span aria-hidden="true" className="inline-flex shrink-0" style={{ color }}><Icon size={11} /></span>}
                  <span className="truncate">{face.name}</span>
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
    </>
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

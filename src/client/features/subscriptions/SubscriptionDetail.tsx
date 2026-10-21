/**
 * One subscription, in full: what it is, how far through its term it is, when it will remind, what it
 * has cost, and the rules that decide when it speaks.
 *
 * The period bar is the one number the reference project never showed and a reader wants most — "12 days
 * left" means something different on a monthly plan than on a three-year one. It is derived from the
 * subscription's own start and expiry, so a plan with no start date simply does not draw one.
 */
import type { ReactElement } from 'react'
import { Plus, RefreshCw, Sparkles, Trash2, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import { LoadingBlock } from '../../components/feedback'
import { daysState, daysStateKey, formatAmount, formatPaid, periodProgress, periodUnitKey } from '@shared/subscriptions/format'
import { renewalsPerYear } from '@shared/subscriptions/currency'
import { labelNamesOf, roundMoney, subscriptionStatus, type PaymentRecord, type ReminderRule, type SubscriptionDetail } from '@shared/subscriptions/model'
import { StatusPill } from './StatusPill'
import { ReminderRuleRow } from './ReminderRuleRow'
import { LabelChip } from './label-identity'

export interface DetailCallbacks {
  onEdit: () => void
  onRenew: () => void
  onToggle: () => void
  onTrash: () => void
  onAddRule: () => void
  onPresetRules: () => void
  onUpdateRule: (rule: ReminderRule, patch: Partial<ReminderRule>) => void
  onDeleteRule: (rule: ReminderRule) => void
  onAcknowledgeRule: (rule: ReminderRule) => void
  onEditPayment: (payment: PaymentRecord) => void
  onDeletePayment: (payment: PaymentRecord) => void
}

export function SubscriptionDetail({
  detail,
  loading,
  onClose,
  callbacks,
}: {
  detail: SubscriptionDetail | null
  loading: boolean
  onClose: () => void
  callbacks: DetailCallbacks
}): ReactElement {
  if (loading && !detail) return <LoadingBlock label={t('subscriptions.loading')} />
  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <p className="text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('subscriptions.detail.empty')}</p>
      </div>
    )
  }

  const { item } = detail
  const status = subscriptionStatus(item, item.daysRemaining)
  const countdown = daysState(item.daysRemaining)
  const progress = periodProgress(item.startDate ? Date.parse(item.startDate) : null, Date.parse(item.expiryDate))
  const amount = formatAmount(item.amount, item.currency)
  // What the plan commits across twelve months at the price it quotes now. The dashboard prints the same
  // projection for the whole account; a reader weighing one plan wants it for that plan alone, in the
  // currency the plan itself is billed in.
  const committedYear = item.amount !== null && item.amount > 0
    ? formatAmount(roundMoney(item.amount * renewalsPerYear(item)), item.currency)
    : ''

  return (
    <div className="no-scrollbar flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[length:var(--text-14)] font-semibold text-[var(--text-primary)]">{item.name}</h2>
            <StatusPill status={status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <LabelChip kind="type" name={item.customType} fallbackLabel={t('subscriptions.detail.uncategorized')} />
            {labelNamesOf(item.category, 'category').map((token) => (
              <LabelChip key={token} kind="category" name={token} />
            ))}
          </div>
        </div>
        <Tooltip label={t('subscriptions.detail.close')} side="left">
          <IconButton label={t('subscriptions.detail.close')} size="sm" onClick={onClose} className="lg:hidden">
            <X size={15} />
          </IconButton>
        </Tooltip>
      </header>

      <div className="flex flex-wrap gap-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
        <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={callbacks.onRenew}>{t('subscriptions.renew.title_short')}</Button>
        <Button size="sm" variant="ghost" onClick={callbacks.onEdit}>{t('subscriptions.edit')}</Button>
        <Button size="sm" variant="ghost" onClick={callbacks.onToggle}>
          {item.isActive ? t('subscriptions.detail.toggle_off') : t('subscriptions.detail.toggle_on')}
        </Button>
        <Tooltip label={t('subscriptions.trash.move')} side="bottom">
          <IconButton label={t('subscriptions.trash.move')} size="sm" onClick={callbacks.onTrash} className="ml-auto">
            <Trash2 size={14} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="px-3 py-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Fact label={t('subscriptions.detail.amount')} value={amount || '—'} strong />
          <Fact label={t('subscriptions.detail.cycle')} value={`${item.periodValue} ${t(periodUnitKey(item.periodUnit))}`} />
          <Fact label={t('subscriptions.detail.expiry')} value={item.expiryDate.slice(0, 10)} />
          <Fact
            label={t('subscriptions.detail.remaining')}
            value={t(daysStateKey(countdown), { count: countdown.count })}
            tone={countdown.kind === 'overdue' ? 'danger' : countdown.kind === 'today' ? 'warning' : undefined}
          />
          <Fact label={t('subscriptions.detail.mode')} value={item.subscriptionMode === 'reset' ? t('subscriptions.detail.mode_reset') : t('subscriptions.detail.mode_cycle')} />
          <Fact label={t('subscriptions.detail.calendar')} value={item.useLunar ? t('subscriptions.detail.calendar_lunar') : t('subscriptions.detail.calendar_solar')} />
          <Fact label={t('subscriptions.detail.auto_renew')} value={item.autoRenew ? t('subscriptions.detail.yes') : t('subscriptions.detail.no')} />
          <Fact label={t('subscriptions.detail.paid_total')} value={formatPaid(item.paidByCurrency) || '—'} />
          {committedYear && <Fact label={t('subscriptions.detail.cost_per_year')} value={committedYear} />}
          {item.trialEndsAt && (
            <Fact
              label={t('subscriptions.detail.trial_ends')}
              value={`${item.trialEndsAt.slice(0, 10)} · ${t('subscriptions.status.days_left', { count: item.trialDaysRemaining ?? 0 })}`}
              tone={(item.trialDaysRemaining ?? 0) < 8 ? 'warning' : undefined}
            />
          )}
        </div>

        {progress !== null && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between text-[length:var(--text-11)] text-[var(--text-tertiary)]">
              <span>{t('subscriptions.detail.period')}</span>
              <span className="tabular-nums">{t('subscriptions.detail.period_progress', { value: progress })}</span>
            </div>
            <div
              className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-inset)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
              aria-label={t('subscriptions.detail.period')}
            >
              <div
                className={cn('h-full rounded-full', progress >= 80 ? 'bg-[var(--warning)]' : 'bg-[var(--accent)]')}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        <p className="mt-3 text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {detail.nextReminder
            ? t('subscriptions.detail.next_reminder_value', { date: detail.nextReminder.nextFireTime.slice(0, 16).replace('T', ' ') })
            : t('subscriptions.detail.no_reminder')}
        </p>

        {item.notes && (
          <p className="mt-2 whitespace-pre-wrap rounded-[var(--r-md)] bg-[var(--bg-inset)] px-2 py-1.5 text-[length:var(--text-11-5)] leading-relaxed text-[var(--text-secondary)]">
            {item.notes}
          </p>
        )}
      </div>

      <section className="border-t border-[var(--border-subtle)] px-3 py-3">
        <div className="flex items-center justify-between">
          <SectionLabel>{t('subscriptions.rules.title')}</SectionLabel>
          <div className="flex items-center gap-1">
            <Tooltip label={t('subscriptions.rules.preset_hint')} side="bottom">
              <Button size="sm" variant="ghost" icon={<Sparkles size={13} />} onClick={callbacks.onPresetRules}>
                {t('subscriptions.rules.preset')}
              </Button>
            </Tooltip>
            <IconButton label={t('subscriptions.rules.add')} size="sm" onClick={callbacks.onAddRule}>
              <Plus size={14} />
            </IconButton>
          </div>
        </div>
        {detail.rules.length === 0
          ? <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('subscriptions.rules.empty')}</p>
          : (
              <ul className="mt-1.5 space-y-1">
                {detail.rules.map((rule) => (
                  <RuleRow key={rule.id} rule={rule} expired={item.daysRemaining < 0} callbacks={callbacks} />
                ))}
              </ul>
            )}
      </section>

      <section className="border-t border-[var(--border-subtle)] px-3 py-3">
        <div className="flex items-center justify-between">
          <SectionLabel>{t('subscriptions.payments.title')}</SectionLabel>
          <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{item.paymentCount}</span>
        </div>
        {detail.yearlySpend.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1" data-yearly-spend="">
            {detail.yearlySpend.map((entry) => (
              <li
                key={`${entry.year}-${entry.currency}`}
                className="flex items-baseline gap-1 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-1.5 py-0.5 text-[length:var(--text-10-5)] tabular-nums"
              >
                <span className="text-[var(--text-tertiary)]">{entry.year}</span>
                <span className="text-[var(--text-primary)]">{formatAmount(entry.amount, entry.currency)}</span>
                <span className="text-[var(--text-quaternary)]">{t('subscriptions.payments.receipts', { count: entry.receipts })}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.payments.length === 0
          ? <p className="mt-1.5 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">{t('subscriptions.payments.empty')}</p>
          : (
              <ol className="mt-2 space-y-2 border-l border-[var(--border-subtle)] pl-3">
                {detail.payments.map((payment) => (
                  <li key={payment.id} className="group relative">
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute -left-[17px] top-1.5 size-1.5 rounded-full border',
                        payment.kind === 'initial'
                          ? 'border-[var(--text-tertiary)] bg-[var(--bg-surface)]'
                          : 'border-[var(--accent)] bg-[var(--accent)]',
                      )}
                    />
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[length:var(--text-12)] tabular-nums text-[var(--text-primary)]">
                        {formatAmount(payment.amount, payment.currency)}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                          {t(PAYMENT_KIND[payment.kind])}
                        </span>
                        <span className="text-[length:var(--text-11)] tabular-nums text-[var(--text-tertiary)]">{payment.paidAt.slice(0, 10)}</span>
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      {payment.note && <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{payment.note}</span>}
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100">
                        <Button size="sm" variant="ghost" className="h-9 px-2 text-[length:var(--text-11)] md:h-6 md:px-1 md:text-[length:var(--text-10-5)]" onClick={() => callbacks.onEditPayment(payment)}>
                          {t('subscriptions.payments.edit')}
                        </Button>
                        <IconButton label={t('subscriptions.payments.delete')} size="xs" className="size-9 md:size-6" onClick={() => callbacks.onDeletePayment(payment)}>
                          <Trash2 size={12} />
                        </IconButton>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
      </section>
    </div>
  )
}

const PAYMENT_KIND: Record<PaymentRecord['kind'], Parameters<typeof t>[0]> = {
  initial: 'subscriptions.payments.kind_initial',
  manual: 'subscriptions.payments.kind_manual',
  auto: 'subscriptions.payments.kind_auto',
}

function Fact({
  label,
  value,
  strong,
  tone,
}: {
  label: string
  value: string
  strong?: boolean
  tone?: 'danger' | 'warning'
}): ReactElement {
  return (
    <div className="min-w-0">
      <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{label}</p>
      <p
        className={cn(
          'mt-0.5 truncate tabular-nums',
          strong ? 'text-[length:var(--text-14)] font-semibold' : 'text-[length:var(--text-12)]',
          tone === 'danger' ? 'text-[var(--danger)]' : tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--text-primary)]',
        )}
      >
        {value}
      </p>
    </div>
  )
}

/**
 * One rule, editable in place.
 *
 * The row itself is shared with the create form — the two differ only in what a change costs. Here it
 * goes straight to the server, because the detail panel is looking at a saved subscription and a rule
 * that changed on screen but not on the worker would be a lie the next reload corrects.
 */
function RuleRow({ rule, expired, callbacks }: { rule: ReminderRule; expired: boolean; callbacks: DetailCallbacks }): ReactElement {
  return (
    <ReminderRuleRow
      rule={rule}
      onPatch={(patch) => callbacks.onUpdateRule(rule, patch)}
      onRemove={() => callbacks.onDeleteRule(rule)}
      canAcknowledge={expired}
      onAcknowledge={() => callbacks.onAcknowledgeRule(rule)}
    />
  )
}

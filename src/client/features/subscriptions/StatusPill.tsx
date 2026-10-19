/**
 * Where a subscription stands, as one pill.
 *
 * The tone is the semantic token rather than a colour: an expired plan and a full disk are the same
 * alarm, and a reader who switched to a different accent should not have to relearn which green means
 * "fine". The word is always there beside the colour, because a pill that only means something to
 * people who can tell two hues apart is a pill half the readers cannot use.
 */
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import type { SubscriptionStatus } from '@shared/subscriptions/model'

const TONE: Record<SubscriptionStatus, { className: string; key: Parameters<typeof t>[0] }> = {
  active: { className: 'text-[var(--success)] bg-[color-mix(in_oklab,var(--success)_14%,transparent)]', key: 'subscriptions.status.active' },
  soon: { className: 'text-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_16%,transparent)]', key: 'subscriptions.status.soon' },
  today: { className: 'text-[var(--warning)] bg-[color-mix(in_oklab,var(--warning)_22%,transparent)]', key: 'subscriptions.status.today' },
  expired: { className: 'text-[var(--danger)] bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]', key: 'subscriptions.status.expired' },
  disabled: { className: 'text-[var(--text-quaternary)] bg-[var(--bg-inset)]', key: 'subscriptions.status.disabled' },
}

export function StatusPill({ status, className }: { status: SubscriptionStatus; className?: string }) {
  const tone = TONE[status]
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5',
        'text-[length:var(--text-10-5)] font-medium leading-none',
        tone.className,
        className,
      )}
    >
      {t(tone.key)}
    </span>
  )
}

/**
 * The same plans, as cards.
 *
 * The list is the right shape for a reader scanning dates: one column, urgency headings, everything
 * aligned so the eye can run down it. The grid is the right shape for looking at a portfolio — a screen
 * of tiles where each plan's face, price and countdown sit together and the eye moves across rather than
 * down. Neither is the better answer in general, which is why the toolbar offers both and both draw from
 * the same filtered, sorted rows.
 *
 * A card carries the row's kebab and the row's right-click, because a plan you can only open is a plan
 * you cannot do anything about from the view you happen to be in.
 */
import { type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, useContextMenu } from '../../components/overlay'
import { daysState, daysStateKey, formatAmount, periodUnitKey } from '@shared/subscriptions/format'
import { subscriptionStatus, type SubscriptionItem } from '@shared/subscriptions/model'
import { StatusPill } from './StatusPill'
import { CurrencyFlag } from './currency-flag'
import { SubscriptionAvatar, SubscriptionKebab, subscriptionMenu, subscriptionSubtitle } from './subscription-parts'
import type { SubscriptionActions } from './SubscriptionList'

export function SubscriptionGrid({
  items,
  selectedId,
  loading,
  onSelect,
  onAdd,
  actions,
}: {
  items: readonly SubscriptionItem[]
  selectedId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onAdd: () => void
  actions: SubscriptionActions
}): ReactElement {
  if (loading) return <LoadingBlock label={t('subscriptions.loading')} />
  if (items.length === 0) {
    return (
      <Empty
        art="subscriptions"
        title={t('subscriptions.overview.empty')}
        description={t('subscriptions.overview.empty_hint')}
        action={<Button variant="primary" icon={<Plus size={14} />} onClick={onAdd}>{t('subscriptions.add')}</Button>}
      />
    )
  }

  return (
    <div className="no-scrollbar h-full overflow-y-auto px-2.5 pb-6 pt-2.5">
      <div role="list" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => (
          <SubscriptionCard
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={onSelect}
            actions={actions}
          />
        ))}
      </div>
    </div>
  )
}

function SubscriptionCard({
  item,
  selected,
  onSelect,
  actions,
}: {
  item: SubscriptionItem
  selected: boolean
  onSelect: (id: string) => void
  actions: SubscriptionActions
}): ReactElement {
  const contextMenu = useContextMenu()
  const status = subscriptionStatus(item, item.daysRemaining)
  const countdown = daysState(item.daysRemaining)
  const amount = formatAmount(item.amount, item.currency)
  const menu = subscriptionMenu(item, actions)

  return (
    <div
      role="listitem"
      className={cn(
        'group relative flex items-start rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)]',
        selected && 'border-[var(--accent)] bg-[var(--accent-soft)]',
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        onContextMenu={contextMenu.onContextMenu}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-w-0 flex-1 flex-col gap-1.5 rounded-[var(--r-lg)] p-2.5 text-left',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <SubscriptionAvatar item={item} />
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{item.name}</span>
          <StatusPill status={status} />
        </span>
        <span className="flex items-center gap-1.5 text-[length:var(--text-14)] font-semibold tabular-nums text-[var(--text-primary)]">
          <CurrencyFlag code={item.currency} />
          <span className="truncate">{amount || '—'}</span>
        </span>
        <span
          className={cn(
            'text-[length:var(--text-11)] tabular-nums',
            countdown.kind === 'overdue' ? 'text-[var(--danger)]' : countdown.kind === 'today' ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]',
          )}
        >
          {t(daysStateKey(countdown), { count: countdown.count })}
        </span>
        <span className="truncate text-[length:var(--text-10-5)] text-[var(--text-tertiary)]">
          {subscriptionSubtitle(item, t(periodUnitKey(item.periodUnit)))}
        </span>
      </button>
      <SubscriptionKebab item={item} actions={actions} />
      {contextMenu.point && (
        <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={menu} label={t('subscriptions.row_actions')} />
      )}
    </div>
  )
}

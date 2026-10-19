/**
 * The subscriptions, under the headings their dates put them in.
 *
 * A row is two siblings rather than one: the part that opens the detail panel is a real button, and the
 * actions menu is its own button beside it. Nesting the second inside the first would be a button in a
 * button, which is the one thing a screen reader cannot describe.
 *
 * The row shows the amount and the countdown on the right and the identity on the left, because those
 * are the two questions a reader opens this app with: what does it cost, and how long have I got.
 */
import { useRef, useState, type ReactElement } from 'react'
import { MoreHorizontal, PencilLine, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, IconButton, SectionLabel } from '../../components/primitives'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
import { daysState, daysStateKey, formatAmount, periodUnitKey } from '@shared/subscriptions/format'
import { subscriptionStatus, type SubscriptionItem } from '@shared/subscriptions/model'
import { StatusPill } from './StatusPill'
import { groupItems, type ListGroup } from './list-view'

const GROUP_LABEL: Record<ListGroup, Parameters<typeof t>[0]> = {
  expired: 'subscriptions.list.group_expired',
  week: 'subscriptions.list.group_week',
  month: 'subscriptions.list.group_month',
  later: 'subscriptions.list.group_later',
  disabled: 'subscriptions.list.group_disabled',
}

export interface SubscriptionActions {
  onEdit: (item: SubscriptionItem) => void
  onRenew: (item: SubscriptionItem) => void
  onToggle: (item: SubscriptionItem) => void
  onDelete: (item: SubscriptionItem) => void
  onTest: (item: SubscriptionItem) => void
}

export function SubscriptionList({
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
    <div className="no-scrollbar h-full overflow-y-auto px-2 pb-6 pt-2">
      {groupItems(items).map((group) => (
        <section key={group.group} className="mb-1">
          <SectionLabel className="sticky top-0 z-10 bg-[var(--bg-base)] px-2 py-1.5">
            {t(GROUP_LABEL[group.group])}
            <span className="ml-1.5 font-normal text-[var(--text-quaternary)]">{group.items.length}</span>
          </SectionLabel>
          <div role="list">
            {group.items.map((item) => (
              <SubscriptionRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onSelect={onSelect}
                actions={actions}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function SubscriptionRow({
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
  const [menuOpen, setMenuOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const status = subscriptionStatus(item, item.daysRemaining)
  const countdown = daysState(item.daysRemaining)
  const amount = formatAmount(item.amount, item.currency)

  const menu: MenuItem[] = [
    { id: 'edit', label: t('subscriptions.edit'), icon: <PencilLine size={14} />, onSelect: () => actions.onEdit(item) },
    { id: 'renew', label: t('subscriptions.renew.confirm'), icon: <RefreshCw size={14} />, onSelect: () => actions.onRenew(item) },
    { id: 'test', label: t('subscriptions.channel.test'), icon: <Send size={14} />, onSelect: () => actions.onTest(item) },
    {
      id: 'toggle',
      label: item.isActive ? t('subscriptions.detail.toggle_off') : t('subscriptions.detail.toggle_on'),
      separatorBefore: true,
      onSelect: () => actions.onToggle(item),
    },
    {
      id: 'delete',
      label: t('subscriptions.delete'),
      icon: <Trash2 size={14} />,
      tone: 'danger',
      onSelect: () => actions.onDelete(item),
    },
  ]

  return (
    <div role="listitem" className={cn('group relative flex items-stretch rounded-[var(--r-md)]', selected && 'bg-[var(--accent-soft)]')}>
      {selected && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--accent)]" />}
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex min-h-[56px] min-w-0 flex-1 items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full text-[length:var(--text-12)] font-semibold',
            'bg-[var(--bg-inset)] text-[var(--text-secondary)]',
          )}
        >
          {item.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{item.name}</span>
            <StatusPill status={status} />
          </span>
          <span className="mt-0.5 block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {[item.customType || t('subscriptions.detail.uncategorized'), item.category, `${item.periodValue} ${t(periodUnitKey(item.periodUnit))}`]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[length:var(--text-13)] font-medium tabular-nums text-[var(--text-primary)]">
            {amount || '—'}
          </span>
          <span
            className={cn(
              'mt-0.5 block text-[length:var(--text-11)] tabular-nums',
              countdown.kind === 'overdue' ? 'text-[var(--danger)]' : countdown.kind === 'today' ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]',
            )}
          >
            {t(daysStateKey(countdown), { count: countdown.count })}
          </span>
        </span>
      </button>
      <div className="flex items-center pr-1.5">
        <Tooltip label={t('subscriptions.row_actions')} side="left">
          <IconButton
            ref={anchor}
            label={t('subscriptions.row_actions')}
            size="sm"
            className={cn('opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', menuOpen && 'opacity-100')}
            onClick={() => setMenuOpen(open => !open)}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        </Tooltip>
        <Menu anchor={anchor} open={menuOpen} onClose={() => setMenuOpen(false)} items={menu} align="end" />
      </div>
    </div>
  )
}

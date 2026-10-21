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
import { type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { Button, SectionLabel } from '../../components/primitives'
import { Checkbox } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, useContextMenu } from '../../components/overlay'
import { daysState, daysStateKey, formatAmount, periodUnitKey } from '@shared/subscriptions/format'
import { subscriptionStatus, type SubscriptionItem } from '@shared/subscriptions/model'
import { StatusPill } from './StatusPill'
import { CurrencyFlag } from './currency-flag'
import { SORT_LABEL, SubscriptionAvatar, SubscriptionKebab, subscriptionMenu, subscriptionSubtitle } from './subscription-parts'
import { groupItems, type ListGroup } from './list-view'
import type { ListSort } from './store'

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
  onTrash: (item: SubscriptionItem) => void
  onTest: (item: SubscriptionItem) => void
}

export function SubscriptionList({
  items,
  sort,
  selectedId,
  loading,
  onSelect,
  onAdd,
  actions,
  selectMode,
  selection,
  onCheck,
}: {
  items: readonly SubscriptionItem[]
  sort: ListSort
  selectedId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onAdd: () => void
  actions: SubscriptionActions
  selectMode: boolean
  selection: readonly string[]
  onCheck: (id: string) => void
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
      {sort === 'expiry'
        ? groupItems(items).map((group) => (
          <section key={group.group} className="mb-1">
            <SectionLabel className="sticky top-0 z-10 bg-[var(--bg-base)] px-2 py-1.5">
              {t(GROUP_LABEL[group.group])}
              <span className="ml-1.5 font-normal text-[var(--text-quaternary)]">{group.items.length}</span>
            </SectionLabel>
            {rows(group.items)}
          </section>
        ))
        /* An ordering that is not about dates has nothing to do with the date headings, and drawing the
           headings anyway would file a reader's most expensive plan under "later". One flat list, under a
           heading that says what it is sorted by. */
        : (
          <section className="mb-1">
            <SectionLabel className="sticky top-0 z-10 bg-[var(--bg-base)] px-2 py-1.5">
              {t(SORT_LABEL[sort])}
              <span className="ml-1.5 font-normal text-[var(--text-quaternary)]">{items.length}</span>
            </SectionLabel>
            {rows(items)}
          </section>
        )}
    </div>
  )

  function rows(list: readonly SubscriptionItem[]): ReactElement {
    return (
      <div role="list">
        {list.map((item) => (
          <SubscriptionRow
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            onSelect={onSelect}
            actions={actions}
            selectMode={selectMode}
            checked={selection.includes(item.id)}
            onCheck={onCheck}
          />
        ))}
      </div>
    )
  }
}

function SubscriptionRow({
  item,
  selected,
  onSelect,
  actions,
  selectMode,
  checked,
  onCheck,
}: {
  item: SubscriptionItem
  selected: boolean
  onSelect: (id: string) => void
  actions: SubscriptionActions
  selectMode: boolean
  checked: boolean
  onCheck: (id: string) => void
}): ReactElement {
  const contextMenu = useContextMenu()
  const status = subscriptionStatus(item, item.daysRemaining)
  const countdown = daysState(item.daysRemaining)
  const amount = formatAmount(item.amount, item.currency)
  const menu = subscriptionMenu(item, actions)

  return (
    <div role="listitem" className={cn('group relative flex items-stretch rounded-[var(--r-md)]', selected && 'bg-[var(--accent-soft)]')}>
      {selected && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--accent)]" />}
      {/* The box is only in the tab order while a selection is being made, so a reader moving through
          the list one row at a time is not asked to answer a question they never opened. */}
      {selectMode && (
        <Checkbox
          className="shrink-0 pl-2.5"
          checked={checked}
          onChange={() => onCheck(item.id)}
          label={<span className="sr-only">{t('subscriptions.bulk.pick', { name: item.name })}</span>}
        />
      )}
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        onContextMenu={contextMenu.onContextMenu}
        aria-current={selected ? 'true' : undefined}
        tabIndex={selectMode ? -1 : undefined}
        className={cn(
          'flex min-h-[56px] min-w-0 flex-1 items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          'hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        )}
      >
        <SubscriptionAvatar item={item} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[length:var(--text-13)] font-medium text-[var(--text-primary)]">{item.name}</span>
            <StatusPill status={status} />
          </span>
          <span className="mt-0.5 block truncate text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
            {subscriptionSubtitle(item, t(periodUnitKey(item.periodUnit)))}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="flex items-center justify-end gap-1.5 text-[length:var(--text-13)] font-medium tabular-nums text-[var(--text-primary)]">
            <CurrencyFlag code={item.currency} />
            <span className="truncate">{amount || '—'}</span>
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
      <SubscriptionKebab item={item} actions={actions} />
      {/* The same list, where the pointer already is. A right-click on a row is the reader asking the
          question the kebab answers, and making them find the kebab first is a second step for nobody. */}
      {contextMenu.point && (
        <Menu anchor={contextMenu.point} open onClose={contextMenu.close} items={menu} label={t('subscriptions.row_actions')} />
      )}
    </div>
  )
}

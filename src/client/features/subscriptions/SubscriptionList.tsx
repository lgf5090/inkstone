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
import { Checkbox } from '../../components/form'
import { Empty, LoadingBlock } from '../../components/feedback'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
import { daysState, daysStateKey, formatAmount, periodUnitKey } from '@shared/subscriptions/format'
import { subscriptionStatus, type SubscriptionItem } from '@shared/subscriptions/model'
import { StatusPill } from './StatusPill'
import { CurrencyFlag } from './currency-flag'
import { iconComponentOf } from './label-icons'
import { useLabelIdentity } from './label-identity'
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
  onTrash: (item: SubscriptionItem) => void
  onTest: (item: SubscriptionItem) => void
}

export function SubscriptionList({
  items,
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
                selectMode={selectMode}
                checked={selection.includes(item.id)}
                onCheck={onCheck}
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
      // Not `danger`: this is the recoverable one, and reserving red for the row that cannot be undone
      // is what makes the trash's own "delete forever" read as the serious choice it is.
      id: 'trash',
      label: t('subscriptions.trash.move'),
      icon: <Trash2 size={14} />,
      onSelect: () => actions.onTrash(item),
    },
  ]

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
            {[item.customType || t('subscriptions.detail.uncategorized'), item.category, `${item.periodValue} ${t(periodUnitKey(item.periodUnit))}`]
              .filter(Boolean)
              .join(' · ')}
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
      <div className="flex items-center pr-1.5">
        <Tooltip label={t('subscriptions.row_actions')} side="left">
          <IconButton
            ref={anchor}
            label={t('subscriptions.row_actions')}
            size="sm"
            className={cn(
              /* Always drawn on touch screens, where there is no hover to reveal it; the desktop keeps the quiet row. */
              'size-11 opacity-100 transition-opacity md:size-6 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100',
              menuOpen && 'md:opacity-100',
            )}
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

/**
 * The row's face.
 *
 * A subscription with a type wears that type's icon in that type's colour, which is what lets a reader
 * scan twelve rows and find the streaming ones without reading; a subscription with no type keeps the
 * neutral initial tile rather than being assigned a colour by hash, because a colour that means
 * "nothing was chosen" teaches the reader nothing and is indistinguishable from a choice they did make.
 */
function SubscriptionAvatar({ item }: { item: SubscriptionItem }): ReactElement {
  const identityOf = useLabelIdentity()
  const identity = item.customType ? identityOf('type', item.customType) : null
  const Icon = identity ? iconComponentOf(identity.icon) : null
  const tint = identity?.color ?? 'var(--text-secondary)'
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full text-[length:var(--text-12)] font-semibold',
        !identity && 'bg-[var(--bg-inset)]',
      )}
      style={identity ? { color: tint, background: `color-mix(in oklab, ${tint} 14%, transparent)` } : undefined}
    >
      {Icon ? <Icon size={15} /> : item.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

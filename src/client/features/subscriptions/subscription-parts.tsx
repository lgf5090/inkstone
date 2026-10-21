/**
 * The pieces a subscription is drawn with, shared by the row and the card.
 *
 * The list and the grid answer the same two questions in different shapes — what does it cost, and how
 * long have I got — and both offer the same handful of actions on one plan. Those actions are the part
 * that must not drift: a card that could not be renewed, or whose kebab offered a different list than its
 * right-click, would be two answers to one question. So the menu is built here, once, from the same
 * `SubscriptionActions` every surface already implements.
 */
import { useRef, useState, type ReactElement } from 'react'
import { MoreHorizontal, PencilLine, RefreshCw, Send, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { cn } from '../../lib/cn'
import { IconButton } from '../../components/primitives'
import { Menu, Tooltip, type MenuItem } from '../../components/overlay'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { type ListSort } from '@shared/subscriptions/sort'
import { iconComponentOf } from './label-icons'
import { useLabelIdentity } from './label-identity'
import type { SubscriptionActions } from './SubscriptionList'

/**
 * What each ordering is called, in the words the interface uses.
 *
 * The toolbar names the choice and the list names the heading it drew under it; two copies of those four
 * strings is how a control ends up offering "cost" over a heading that says "monthly equivalent".
 */
export const SORT_LABEL: Record<ListSort, Parameters<typeof t>[0]> = {
  expiry: 'subscriptions.list.sort_expiry',
  cost: 'subscriptions.list.sort_cost',
  name: 'subscriptions.list.sort_name',
  amount: 'subscriptions.list.sort_amount',
}

/**
 * The row's face.
 *
 * A subscription with a type wears that type's icon in that type's colour, which is what lets a reader
 * scan twelve rows and find the streaming ones without reading; a subscription with no type keeps the
 * neutral initial tile rather than being assigned a colour by hash, because a colour that means
 * "nothing was chosen" teaches the reader nothing and is indistinguishable from a choice they did make.
 */
export function SubscriptionAvatar({ item }: { item: SubscriptionItem }): ReactElement {
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

/** The line under a plan's name: what it is, where it sits, how often it charges. */
export function subscriptionSubtitle(item: SubscriptionItem, period: string): string {
  return [item.customType || t('subscriptions.detail.uncategorized'), item.category, `${item.periodValue} ${period}`]
    .filter(Boolean)
    .join(' · ')
}

/** Everything one plan can be asked to do, in the order both surfaces show it. */
export function subscriptionMenu(item: SubscriptionItem, actions: SubscriptionActions): MenuItem[] {
  return [
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
}

/**
 * The kebab beside a row or a card.
 *
 * It is a sibling of the control that opens the detail panel rather than its child: a button inside a
 * button is the one thing a screen reader cannot describe.
 */
export function SubscriptionKebab({ item, actions, className }: {
  item: SubscriptionItem
  actions: SubscriptionActions
  className?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <div className="flex items-center pr-1.5">
      <Tooltip label={t('subscriptions.row_actions')} side="left">
        <IconButton
          ref={anchor}
          label={t('subscriptions.row_actions')}
          size="sm"
          className={cn(
            /* Always drawn on touch screens, where there is no hover to reveal it; the desktop keeps the quiet row. */
            'size-11 opacity-100 transition-opacity md:size-6 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100',
            open && 'md:opacity-100',
            className,
          )}
          onClick={() => setOpen(value => !value)}
        >
          <MoreHorizontal size={15} />
        </IconButton>
      </Tooltip>
      <Menu anchor={anchor} open={open} onClose={() => setOpen(false)} items={subscriptionMenu(item, actions)} align="end" />
    </div>
  )
}

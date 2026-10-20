/**
 * The trash: what was deleted, and the two ways to deal with it.
 *
 * A separate view rather than another mode of the subscription list, because the list's whole organising
 * idea is *when does this expire* — the buckets, the countdown colour, the renew shortcut — and none of
 * that means anything for a row nobody is being reminded about. A trashed subscription is sorted by when
 * it was discarded and offers exactly two actions: put it back, or make it gone.
 *
 * Nothing else lives here. Editing, renewing or testing a trashed subscription would all have to decide
 * what happens when it is restored afterwards, and a trash that can be quietly modified is a trash whose
 * contents cannot be trusted.
 */
import { type ReactElement } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { t } from '../../lib/i18n'
import { Button, IconButton } from '../../components/primitives'
import { Empty } from '../../components/feedback'
import { formatAmount } from '@shared/subscriptions/format'
import type { SubscriptionItem } from '@shared/subscriptions/model'

export function TrashView({ items, onRestore, onPurge, onEmpty }: {
  items: readonly SubscriptionItem[]
  onRestore: (item: SubscriptionItem) => void
  onPurge: (item: SubscriptionItem) => void
  onEmpty: () => void
}): ReactElement {
  if (!items.length) {
    return (
      <Empty
        art="trash"
        title={t('subscriptions.trash.is_empty')}
        description={t('subscriptions.trash.is_empty_hint')}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 py-3">
      <div className="flex items-center justify-between gap-2 pb-2">
        <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">
          {t('subscriptions.trash.count', { count: items.length })}
        </p>
        <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onEmpty}>
          {t('subscriptions.trash.empty')}
        </Button>
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2.5 py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[length:var(--text-13)] text-[var(--text-primary)]">{item.name}</span>
              <span className="mt-0.5 block truncate text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
                {[
                  item.customType,
                  t('subscriptions.trash.deleted_on', { date: item.deletedAt?.slice(0, 10) ?? '—' }),
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="shrink-0 text-[length:var(--text-12)] tabular-nums text-[var(--text-tertiary)]">
              {formatAmount(item.amount, item.currency)}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="secondary" icon={<RotateCcw size={12} />} onClick={() => onRestore(item)}>
                {t('subscriptions.trash.restore')}
              </Button>
              <IconButton label={t('subscriptions.trash.purge')} size="sm" onClick={() => onPurge(item)}>
                <Trash2 size={13} />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One account as a compact row: its name and one dot per allowance it has.
 *
 * The dots are a glance, not the reading. Opening the row is what shows the percentages, and the row
 * is a button so that press is the same with a keyboard as with a pointer.
 */
import type { AccountQuotaView } from '@shared/cloudflare/model'
import { cn } from '../../../../lib/cn'
import { useCfT } from '../../i18n'
import {
  QUOTA_RESOURCE_ORDER,
  quotaResourceLabel,
  quotaTone,
  quotaUsedPercent,
  type QuotaResourceRow,
} from '../../lib/quota-view'

function dotColor(row: QuotaResourceRow): string {
  if (row.exhausted) return 'var(--danger)'
  return quotaTone(quotaUsedPercent(row))
}

export function CompactAccountCard({
  account,
  onOpen,
}: {
  account: AccountQuotaView
  onOpen: () => void
}) {
  const tcf = useCfT()
  const ordered = QUOTA_RESOURCE_ORDER
    .filter((key) => account.resources.some((row) => row.resource === key))
    .map((key) => account.resources.find((row) => row.resource === key) as QuotaResourceRow)
  const emptyDots = Math.max(0, QUOTA_RESOURCE_ORDER.length - ordered.length)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      title={account.account_name}
      className={cn(
        'flex h-8 w-full min-w-0 items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border-subtle)]',
        'bg-[var(--bg-raised)] px-2 text-left transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        ordered.length === 0 && 'opacity-60',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12)] text-[var(--text-primary)]">
        {account.account_name}
      </span>
      <span aria-hidden="true" className="flex shrink-0 gap-0.5">
        {ordered.map((row) => (
          <span
            key={row.resource}
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor(row) }}
            title={`${quotaResourceLabel(row.resource)} · ${row.count} / ${row.limit}`}
          />
        ))}
        {Array.from({ length: emptyDots }, (_, index) => (
          <span
            key={`empty-${index}`}
            className="size-2 shrink-0 rounded-full bg-[var(--text-quaternary)] opacity-30"
          />
        ))}
      </span>
      <span className="sr-only">
        {tcf('cloudflare.dashboard.today_quota')}
        {ordered.map((row) => ` — ${quotaResourceLabel(row.resource)}: ${row.count} / ${row.limit}`).join('')}
      </span>
    </button>
  )
}

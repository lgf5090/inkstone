/**
 * The rail: which slice of the list is showing, and what is in each slice.
 *
 * Counts come from the same rows the list draws, so a heading that says three and a list that shows two
 * cannot happen. The channel summary at the bottom is there because a reader whose reminders stopped
 * arriving looks first at the list and second at "did anything send at all" — this answers the second
 * before they have to open the settings.
 */
import type { ReactElement } from 'react'
import { AlertTriangle, CalendarClock, CircleSlash, LayoutDashboard, List, Tag } from 'lucide-react'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { SectionLabel } from '../../components/primitives'
import { Tooltip } from '../../components/overlay'
import type { ChannelState } from '@shared/subscriptions/model'
import { categoryCounts, type ListCounts } from './list-view'
import type { StatusFilter, SubscriptionsView } from './store'
import type { SubscriptionItem } from '@shared/subscriptions/model'

export function FilterRail({
  view,
  status,
  category,
  items,
  counts,
  channels,
  onView,
  onStatus,
  onCategory,
  onSettings,
}: {
  view: SubscriptionsView
  status: StatusFilter
  category: string | null
  items: readonly SubscriptionItem[]
  counts: ListCounts
  channels: readonly ChannelState[]
  onView: (view: SubscriptionsView) => void
  onStatus: (status: StatusFilter) => void
  onCategory: (category: string | null) => void
  onSettings: () => void
}): ReactElement {
  const enabled = channels.filter((channel) => channel.enabled && channel.configured)
  const failing = enabled.filter((channel) => channel.lastTestStatus === 'failed')
  const categories = categoryCounts(items)

  return (
    <nav aria-label={t('subscriptions.rail.all')} className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-2">
      <RailRow
        icon={<LayoutDashboard size={15} />}
        label={t('subscriptions.rail.overview')}
        active={view === 'overview'}
        onClick={() => onView('overview')}
      />
      <RailRow
        icon={<List size={15} />}
        label={t('subscriptions.rail.all')}
        count={counts.all}
        active={view === 'list' && status === 'all' && category === null}
        onClick={() => { onView('list'); onStatus('all'); onCategory(null) }}
      />
      <RailRow
        icon={<CalendarClock size={15} />}
        label={t('subscriptions.rail.soon')}
        count={counts.soon}
        tone={counts.soon > 0 ? 'warning' : undefined}
        active={view === 'list' && status === 'soon'}
        onClick={() => { onView('list'); onStatus('soon'); onCategory(null) }}
      />
      <RailRow
        icon={<AlertTriangle size={15} />}
        label={t('subscriptions.rail.expired')}
        count={counts.expired}
        tone={counts.expired > 0 ? 'danger' : undefined}
        active={view === 'list' && status === 'expired'}
        onClick={() => { onView('list'); onStatus('expired'); onCategory(null) }}
      />
      <RailRow
        icon={<CircleSlash size={15} />}
        label={t('subscriptions.rail.disabled')}
        count={counts.disabled}
        active={view === 'list' && status === 'disabled'}
        onClick={() => { onView('list'); onStatus('disabled'); onCategory(null) }}
      />

      {categories.length > 0 && (
        <div className="mt-3">
          <SectionLabel className="px-2 pb-1">{t('subscriptions.rail.categories')}</SectionLabel>
          {categories.map((entry) => (
            <RailRow
              key={entry.name}
              icon={<Tag size={14} />}
              label={entry.name}
              count={entry.count}
              active={view === 'list' && category === entry.name}
              onClick={() => { onView('list'); onStatus('all'); onCategory(entry.name) }}
            />
          ))}
        </div>
      )}

      <div className="mt-auto pt-3">
        <SectionLabel className="px-2 pb-1">{t('subscriptions.rail.channels')}</SectionLabel>
        <button
          type="button"
          onClick={onSettings}
          className={cn(
            'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left',
            'text-[length:var(--text-12)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
          )}
        >
          <span aria-hidden="true" className="flex items-center gap-0.5">
            {channels.map((channel) => (
              <span
                key={channel.kind}
                className={cn(
                  'size-1.5 rounded-full',
                  channel.enabled && channel.configured
                    ? channel.lastTestStatus === 'failed' ? 'bg-[var(--danger)]' : 'bg-[var(--success)]'
                    : 'bg-[var(--border-strong)]',
                )}
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {enabled.length === 0 ? t('subscriptions.channel.none_enabled') : t('subscriptions.channel.enabled_count', { count: enabled.length })}
          </span>
          {failing.length > 0 && (
            <Tooltip label={t('subscriptions.channel.test_failed', { error: '' })} side="right">
              <span className="size-1.5 rounded-full bg-[var(--danger)]" />
            </Tooltip>
          )}
        </button>
      </div>
    </nav>
  )
}

function RailRow({
  icon,
  label,
  count,
  active,
  tone,
  onClick,
}: {
  icon: ReactElement
  label: string
  count?: number
  active?: boolean
  tone?: 'warning' | 'danger'
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--r-md)] px-2 py-1.5 text-left',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
      )}
    >
      <span aria-hidden="true" className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--text-12-5)]">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            'shrink-0 text-[length:var(--text-11)] tabular-nums',
            tone === 'danger' ? 'text-[var(--danger)]' : tone === 'warning' ? 'text-[var(--warning)]' : 'text-[var(--text-quaternary)]',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

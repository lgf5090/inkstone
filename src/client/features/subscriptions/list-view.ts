/**
 * How the list is narrowed and how it is grouped.
 *
 * Both are pure functions of the rows and the filter, which is what lets the counts in the rail and the
 * rows under them come from the same place: a rail that said "3 expiring" over a list showing two would
 * be the kind of disagreement that makes a reader stop trusting the numbers.
 */
import { SOON_DAYS, type SubscriptionItem } from '@shared/subscriptions/model'
import { matchesSubscriptionSearch } from '@shared/subscriptions/search'
import type { RateTable } from '@shared/subscriptions/currency'
import { sortSubscriptions } from '@shared/subscriptions/sort'
import type { ListFilter } from './store'

export type ListGroup = 'expired' | 'week' | 'month' | 'later' | 'disabled'

const GROUP_ORDER: readonly ListGroup[] = ['expired', 'week', 'month', 'later', 'disabled']

/** Which bucket a row falls in. A stopped subscription is its own bucket whatever its date says. */
export function groupOf(item: SubscriptionItem): ListGroup {
  if (!item.isActive) return 'disabled'
  if (item.daysRemaining < 0) return 'expired'
  if (item.daysRemaining <= SOON_DAYS) return 'week'
  if (item.daysRemaining <= 30) return 'month'
  return 'later'
}

/** Whether a row survives the current filter. */
export function matchesFilter(item: SubscriptionItem, filter: ListFilter): boolean {
  if (filter.status === 'soon' && !(item.isActive && item.daysRemaining >= 0 && item.daysRemaining <= SOON_DAYS)) return false
  if (filter.status === 'expired' && !(item.isActive && item.daysRemaining < 0)) return false
  if (filter.status === 'disabled' && item.isActive) return false
  if (filter.category && !categoryList(item).includes(filter.category)) return false
  const query = filter.query.trim()
  if (!query) return true
  // One vocabulary for "which plan does this text name": the chat tool and the global search read the same
  // field list, and a third hand-written copy here is how typing finds a plan in one place and not another.
  return matchesSubscriptionSearch(item, query)
}

/** The labels a subscription carries; the category field may name several. */
export function categoryList(item: SubscriptionItem): string[] {
  return item.category
    .split(/[/\uFF0C,\s]+/)
    .map((label) => label.trim())
    .filter(Boolean)
}

export interface GroupedItems {
  group: ListGroup
  items: SubscriptionItem[]
}

/**
 * The rows under their headings, soonest first inside each.
 *
 * An empty bucket is dropped rather than drawn: five headings with three of them empty is a page that
 * looks broken rather than a page that is organised.
 */
export function groupItems(items: readonly SubscriptionItem[]): GroupedItems[] {
  const buckets = new Map<ListGroup, SubscriptionItem[]>()
  for (const item of items) {
    const group = groupOf(item)
    const bucket = buckets.get(group) ?? []
    bucket.push(item)
    buckets.set(group, bucket)
  }
  return GROUP_ORDER
    .filter((group) => (buckets.get(group)?.length ?? 0) > 0)
    .map((group) => ({
      group,
      items: (buckets.get(group) ?? []).sort((left, right) => left.daysRemaining - right.daysRemaining),
    }))
}

export interface ListCounts {
  all: number
  soon: number
  expired: number
  disabled: number
}

/** What the rail prints beside each view, counted off the same rows the list draws. */
export function countItems(items: readonly SubscriptionItem[]): ListCounts {
  let soon = 0
  let expired = 0
  let disabled = 0
  for (const item of items) {
    if (!item.isActive) disabled++
    else if (item.daysRemaining < 0) expired++
    else if (item.daysRemaining <= SOON_DAYS) soon++
  }
  return { all: items.length, soon, expired, disabled }
}

/** How many subscriptions name each category, for the rail's category list. */
export function categoryCounts(items: readonly SubscriptionItem[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const label of categoryList(item)) counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}

/** Everything the list shows for one filter, in one call. */
/**
 * The rows the list shows, in the order the toolbar asked for.
 *
 * The rate table travels with the call because two of the four orderings are about money: sorting "what
 * costs most per month" at face value would file a $20 plan under a ¥150 one, and the reader would be
 * left deciding which of the two numbers this app actually believes.
 */
export function visibleItems(items: readonly SubscriptionItem[], filter: ListFilter, rates: RateTable): SubscriptionItem[] {
  return sortSubscriptions(items.filter((item) => matchesFilter(item, filter)), filter.sort, rates)
}

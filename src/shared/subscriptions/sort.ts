/**
 * One answer to "in what order do these rows go".
 *
 * The rail's list and the chat tool's listing are the same rows, and a reader who asks the assistant to
 * name their plans and then looks up at the screen should not find them in a different order — so the
 * comparison lives here, once, and both ends read it.
 *
 * Names are folded to lower case and compared as code points rather than through a collation locale.
 * That is a deliberate loss: an order that changes between the browser's language and the worker's would
 * be worse than an order that is merely not dictionary-perfect for Chinese, where the code points run
 * roughly by how common each character is.
 */
import { convertToBase, monthlyEquivalent, type RateTable } from './currency'
import type { SubscriptionItem } from './model'

export const LIST_SORTS = ['expiry', 'cost', 'name', 'amount'] as const
export type ListSort = (typeof LIST_SORTS)[number]

export function isListSort(value: unknown): value is ListSort {
  return typeof value === 'string' && (LIST_SORTS as readonly string[]).includes(value)
}

/** The direction each ordering runs in, and what breaks its ties. */
function compare(sort: ListSort, rates: RateTable): (left: SubscriptionItem, right: SubscriptionItem) => number {
  const byDate = (left: SubscriptionItem, right: SubscriptionItem) => left.daysRemaining - right.daysRemaining
  if (sort === 'cost') {
    return (left, right) => monthlyEquivalent(right, rates) - monthlyEquivalent(left, rates) || byDate(left, right)
  }
  if (sort === 'amount') {
    return (left, right) => {
      const charge = (item: SubscriptionItem) => convertToBase(item.amount ?? 0, item.currency, rates)
      return charge(right) - charge(left) || byDate(left, right)
    }
  }
  if (sort === 'name') {
    // Compared as code points, not through `localeCompare`: the browser and the worker do not agree on a
    // default collation, and two orders for one list is exactly the disagreement this file exists to stop.
    return (left, right) => {
      const a = left.name.toLocaleLowerCase()
      const b = right.name.toLocaleLowerCase()
      return (a < b ? -1 : a > b ? 1 : 0) || byDate(left, right)
    }
  }
  // The app's own question: what is about to run out, with stopped plans keeping their own place by date.
  return byDate
}

/**
 * The rows in the requested order.
 *
 * Sorted on a copy: callers keep their array for the counts in the rail, and an in-place sort would
 * quietly reorder the list a heading was just counted off.
 */
export function sortSubscriptions(items: readonly SubscriptionItem[], sort: ListSort, rates: RateTable): SubscriptionItem[] {
  return [...items].sort(compare(sort, rates))
}

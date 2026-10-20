import type { SubscriptionItem } from './model'

/**
 * One spelling of "which subscription does this text name".
 *
 * The chat tool filters a listing and the global search filters the same rows over HTTP. Two hand-written
 * haystacks drift — one grows the notes field, the other keeps ignoring it — and then a reader can find a
 * subscription by typing in one place and not the other. So the fields and the folding live here.
 */

/** How many rows a global search shows before the reader has to narrow the text. */
export const SUBSCRIPTION_SEARCH_LIMIT = 8

/** The longest query the app will match, in characters of whatever the reader typed. */
export const SUBSCRIPTION_SEARCH_MAX = 120

/** What a search box and a conversation both mean by the same words, ignoring case and accents' order. */
export function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function haystackOf(item: SubscriptionItem): string {
  return `${item.name} ${item.customType} ${item.category} ${item.notes}`.toLocaleLowerCase()
}

/**
 * Whether `query` names this subscription.
 *
 * An empty query matches nothing rather than everything: every caller asks in the middle of a search, and
 * "the reader typed nothing" must not read as "all forty of their plans matched".
 */
export function matchesSubscriptionSearch(item: SubscriptionItem, query: string): boolean {
  const wanted = normalizeSearchText(query)
  if (!wanted) return false
  return haystackOf(item).includes(wanted)
}

/**
 * The nearest rows for a search box, soonest-expiring first.
 *
 * Sorting by what is about to run out is the order the app already uses for a filtered list, so a hit from
 * the global search lands in a list that looks the same rather than a differently ordered one.
 */
export function searchSubscriptions(items: readonly SubscriptionItem[], query: string, limit = SUBSCRIPTION_SEARCH_LIMIT): SubscriptionItem[] {
  if (!normalizeSearchText(query)) return []
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 20)
  return items
    .filter((item) => matchesSubscriptionSearch(item, query))
    .sort((left, right) => left.daysRemaining - right.daysRemaining)
    .slice(0, capped)
}

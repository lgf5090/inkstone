/**
 * Landing on one subscription from somewhere outside its app.
 *
 * The global search and the notification bell both hold a subscription the reader wants in front of them,
 * and neither owns the tab bar. This is the one place that says how a row becomes a screen: go to the app,
 * ask for the list (the overview has nothing to show for a single plan), then select it, which is the same
 * action the row itself would have taken.
 */
import { navigateToPath } from '../../lib/app-history'
import type { SubscriptionItem } from '@shared/subscriptions/model'
import { useSubscriptions } from './store'

/** Opens a plan the caller only has an id for — a notification stores the id, not the row. */
export function openSubscriptionById(id: string): void {
  navigateToPath('/subscriptions')
  const store = useSubscriptions.getState()
  store.setView('list')
  void store.select(id)
}

export function openSubscriptionInApp(item: SubscriptionItem): void {
  openSubscriptionById(item.id)
}

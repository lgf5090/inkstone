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

export function openSubscriptionInApp(item: SubscriptionItem): void {
  navigateToPath('/subscriptions')
  const store = useSubscriptions.getState()
  store.setView('list')
  void store.select(item.id)
}

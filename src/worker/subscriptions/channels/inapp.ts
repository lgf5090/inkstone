/**
 * Delivery into the reader's own app.
 *
 * Every other channel hands the message to a service outside this deployment, which is why each of them
 * is one HTTP request and a credential. This one is a row in `chat_notifications` — the same table the
 * assistant's own routines deliver into, and the same bell the reader already reads — so what it needs is
 * the account and its database, not a configuration. That is also why `DeliveryAccount` is declared here
 * rather than in the fan-out: it is the one channel's requirement, and the fan-out only passes it along.
 *
 * A Web Push nudge follows the row, and it carries a count and nothing else. `push-fanout.ts` keeps that
 * rule in one place: a push service sits outside this app's trust domain, so a reminder about a plan
 * named in another reader's language must not become something it can be told. A nudge that fails does
 * not fail this delivery, because the row is the record and the inbox is where the message is; the
 * nudge's numbers come back as the log detail so an operator can see a deployment that reaches nobody.
 */
import type { Env } from '../../env'
import type { ChannelPayload, ChannelResult } from '@shared/subscriptions/channels'
import { AssistantStore } from '../../assistant/store'
import { nudgeAccount, newPushFanoutTally } from '../../assistant/push-fanout'
import { vapidProblem } from '../../assistant/push'

export interface DeliveryAccount {
  env: Env
  userId: string
}

export async function sendInApp(payload: ChannelPayload, account: DeliveryAccount): Promise<ChannelResult> {
  const store = new AssistantStore(account.env.DB, account.userId, account.env)
  const notification = await store.createNotification({
    title: payload.title,
    body: payload.content,
    subscriptionId: payload.subscriptionId ?? null,
  })

  // The row is the delivery, so an unread device is a report and never a refusal to write it.
  const problem = vapidProblem(account.env)
  if (problem) return { success: true, channel: 'inapp', detail: problem }

  const tally = newPushFanoutTally()
  await nudgeAccount(account.env, account.userId, [notification.id], tally)
  const refused = tally.refused + tally.errors
  const detail = tally.devices === 0
    ? 'No device is registered for push'
    : `Nudged ${tally.sent} of ${tally.devices} device(s)${refused > 0 ? `, ${refused} refused` : ''}`
  return { success: true, channel: 'inapp', detail }
}

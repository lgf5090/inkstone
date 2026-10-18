/**
 * The nudge that goes out when a scheduled routine delivered a notification.
 *
 * Two rules shape this whole file, and both are about what a push here is for.
 *
 * A push is a courtesy, never the delivery. The reader's own notification list is the record, and the row
 * `createNotification` wrote is the thing that has to exist. So nothing in here may turn a refused send, an
 * unconfigured deployment or a dead push service into a failed routine: the fan-out runs after the row and
 * off the tick's critical path, and every problem it meets comes back as a number in `PushFanoutTally`
 * rather than as an exception into the sweep. That is not silence — the sender's own accounting
 * (`notePushFailure`, `last_error`, the five-refusal drop) still runs for every device, and the tally is
 * what the sweep result carries, so a deployment that has been nudging nobody for a week is countable.
 *
 * A push says only "there is something to read". `sendPush` declares the `aes128gcm` content coding without
 * applying RFC 8291 payload encryption, so the body reaches the push service in the clear, and a push
 * service is not inside this app's trust domain: it may log what it is handed, mirror it, or keep it for the
 * life of the message. The payload is therefore one fixed signal plus one number — no title, no body, no
 * note name, no conversation name, no notification id, nothing its reader's text could be recovered from.
 * The browser answers a nudge by fetching `/api/assistant/notifications` as itself, which is the only place
 * the content lives. Adding a field to `pushPingPayload` means adding it to the privacy assertions in
 * `tests/push-fanout.test.ts` first, and those assertions are the red line, not a detail of the fixture.
 */

import type { Env } from '../env'
import { AssistantStore, type AssistantPushSubscription } from './store'
import { sendPush, vapidProblem } from './push'

/**
 * The one word a payload is allowed to carry.
 *
 * It is a protocol constant rather than copy: an interface that localises its own notification text must
 * not be able to put that text into what leaves for the push service.
 */
export const PUSH_PING_KIND = 'inkstone:notifications'

/** The upper bound a nudge will report, so a nonsense count cannot become the number a reader sees. */
const PUSH_PING_COUNT_CAP = 999

/**
 * The whole of what a device is told: this app has something for this account, and how many rows.
 *
 * Built as a fixed key list on purpose — the object has no field that a notification could reach, so a
 * future caller cannot smuggle text in by passing one through.
 */
export function pushPingPayload(count: number): string {
  const sane = Math.min(Math.max(Math.trunc(count), 0), PUSH_PING_COUNT_CAP)
  return JSON.stringify({ kind: PUSH_PING_KIND, count: sane })
}

/**
 * What one fan-out cost, as the sweep reports it.
 *
 * Mutable and passed in because the same counting serves the nudge a sweep hands over and the catch-up a
 * later fire makes: each device adds to exactly one field, and the caller hands the object to whoever reads
 * the tick's result.
 */
export interface PushFanoutTally {
  /** Accounts this fan-out had something for. */
  accounts: number
  /** Notification rows the nudge covers, across those accounts. */
  notifications: number
  /** Accounts it looked at and found no device registered for. */
  accountsWithoutDevice: number
  /** Devices the nudge was addressed to. */
  devices: number
  /** Devices that answered 201 — a message the push service queued. */
  sent: number
  /** Devices that refused; the sender counted each against its own subscription. */
  refused: number
  /** Endpoints a service declared gone; the sender deleted those subscription rows. */
  expired: number
  /** Sends that blew up before an answer, and subscriptions that could not be read: counted, never swallowed. */
  errors: number
  /** The operator's sentence for a deployment with no usable VAPID keys; null when it can send. */
  configuration: string | null
}

/** A tally with nothing in it, which is also the shape a fan-out that never ran reports. */
export function newPushFanoutTally(): PushFanoutTally {
  return {
    accounts: 0,
    notifications: 0,
    accountsWithoutDevice: 0,
    devices: 0,
    sent: 0,
    refused: 0,
    expired: 0,
    errors: 0,
    configuration: null,
  }
}

/**
 * Nudge one account's devices about the rows it is holding for them.
 *
 * The subscription table is read once per account per call and then looped over, so a tick that delivered
 * three notifications to one reader sends three devices' worth of requests, not nine, and never re-queries
 * the credential table per notification. `sendPush` owns what happens to a refusal: 404 and 410 delete the
 * row, anything else is counted against it until the store's own limit drops it.
 *
 * The `notificationIds` are only counted, never carried: what a device is told is how many rows there are.
 */
export async function nudgeAccount(
  env: Env,
  userId: string,
  notificationIds: readonly string[],
  tally: PushFanoutTally,
): Promise<void> {
  tally.accounts += 1
  tally.notifications += notificationIds.length
  const store = new AssistantStore(env.DB, userId, env)
  let subscriptions: AssistantPushSubscription[]
  try {
    subscriptions = await store.listPushSubscriptions()
  } catch (error) {
    // A reader's devices could not be listed. The notification row is already written, so this is reported
    // and left at that: retrying a D1 read inside a cron is the same failure one level down.
    tally.errors += 1
    console.error('[inkstone] push fan-out could not read a subscription list:', errorDetail(error))
    return
  }
  if (!subscriptions.length) {
    tally.accountsWithoutDevice += 1
    return
  }
  const payload = pushPingPayload(notificationIds.length)
  for (const subscription of subscriptions) {
    tally.devices += 1
    try {
      const result = await sendPush(subscription, payload, env)
      if (result.outcome === 'sent') {
        tally.sent += 1
        continue
      }
      if (result.outcome === 'expired') tally.expired += 1
      else tally.refused += 1
      // `detail` is already redacted by the sender; it is worth a log line because a deployment that cannot
      // reach any push service otherwise shows up only as a number.
      console.error('[inkstone] push send refused:', `status ${result.statusCode}`, result.detail)
    } catch (error) {
      // Only a send that never got to ask arrives here — an unconfigured deployment is checked by the caller
      // before any request, and a service's refusal comes back as a result. The message of what did throw is
      // the deployment's own problem named in the sender's words, never a device's credential.
      tally.errors += 1
      console.error('[inkstone] push send failed before an answer:', errorDetail(error))
    }
  }
}

/**
 * The notifications one account has delivered since the last nudge, waiting to be sent.
 *
 * Accumulated per account rather than sent per notification, because the payload carries a count: one tick
 * that produced three rows for one reader is one nudge saying "three", and the subscription table is read
 * once for all of them.
 */
export class NotificationPushFanout {
  private readonly pending = new Map<string, string[]>()

  constructor(private readonly env: Env) {}

  /**
   * Note one delivered notification.
   *
   * Called only after the row is written. What is kept is the account and the row's id — no title, no body —
   * so the payload cannot pick up a reader's text even by accident.
   */
  track(userId: string, notificationId: string): void {
    const ids = this.pending.get(userId)
    if (ids) ids.push(notificationId)
    else this.pending.set(userId, [notificationId])
  }

  /** Whether anything was delivered that a device should hear about. */
  get empty(): boolean {
    return this.pending.size === 0
  }

  /**
   * Hand every waiting account its nudge, and report what it cost.
   *
   * The returned promise is the fan-out's whole life: a caller that has an `ExecutionContext` gives it to
   * `waitUntil` so the sends run without lengthening the tick, and one that has nothing awaits it and gets
   * the same tally. It resolves rather than rejects even when every device refused — the numbers are the
   * answer, and the delivery they follow has already happened.
   */
  flush(): Promise<PushFanoutTally> {
    return flushPushFanout(this.env, this.pending)
  }
}

/**
 * Sends what one accumulator is holding and returns the counts.
 *
 * Split out from the class because the cron's catch-up fire needs the identical walk — a per-account list,
 * a loop over its devices, one tally — over a set of notifications it read back from the database instead
 * of one it produced itself.
 */
export async function flushPushFanout(
  env: Env,
  pending: Map<string, string[]>,
): Promise<PushFanoutTally> {
  const tally = newPushFanoutTally()
  if (!pending.size) return tally
  const problem = vapidProblem(env)
  if (problem) {
    // This deployment's own fault, so it is named once and no device is blamed for it: nothing is sent and
    // no subscription is counted as failing. A fan-out that sent through `sendPush` here would be deleting
    // every reader's devices after five ticks of an operator forgetting a secret.
    tally.configuration = problem
    tally.accounts = pending.size
    for (const ids of pending.values()) tally.notifications += ids.length
    return tally
  }
  for (const [userId, ids] of [...pending]) {
    pending.delete(userId)
    await nudgeAccount(env, userId, ids, tally)
  }
  return tally
}

/** An exception's own words, never a stack, and never anything the sender did not already redact. */
function errorDetail(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200)
}

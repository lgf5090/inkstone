/**
 * The nudge that goes out when a scheduled routine delivered a notification, and the fire that says it again.
 *
 * Two entry points, one set of rules: `NotificationPushFanout` is the immediate path a sweep hands over
 * (`scheduler.ts`), and `runPushCatchUp` is the cron's later pass over whatever that path never got said.
 * Both walk the same `nudgeAccount`, so a payload rule is written once.
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
import { accountsWithUnpushedNotifications, AssistantStore, type AssistantPushSubscription } from './store'
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
  /** Sends that blew up before an answer, and listings that failed: counted, never swallowed. */
  errors: number
  /** Notification rows stamped `pushed_at` by this fan-out, which is what makes a later fire skip them. */
  marked: number
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
    marked: 0,
    configuration: null,
  }
}

/**
 * Nudge one account's devices about the rows it is holding for them.
 *
 * The subscription table is read once per account per call and then looped over, so a tick that delivered
 * three notifications to one reader sends three devices' worth of requests, not nine, and never re-queries
 * the credential table per notification. `sendPush` owns what happens to a refusal: 404 and 410 delete the
 * row, anything else is counted against it until the store's own limit drops it. That is also the only way
 * this deployment learns an endpoint is dead, which is why the clean-up of gone devices happens here rather
 * than on a timer.
 *
 * The `notificationIds` are only counted, never carried: what a device is told is how many rows there are.
 * When one of them accepts, the rows are stamped `pushed_at`, and that stamp is what the catch-up fire below
 * reads — one acceptance is enough, because the nudge says "there is something to read" and the next
 * notification this reader gets will ask this device again anyway.
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
  let accepted = 0
  for (const subscription of subscriptions) {
    tally.devices += 1
    try {
      const result = await sendPush(subscription, payload, env)
      if (result.outcome === 'sent') {
        tally.sent += 1
        accepted += 1
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
  if (!accepted || !notificationIds.length) return
  try {
    const marked = await store.markNotificationsPushed(notificationIds)
    tally.marked += marked
  } catch (error) {
    // The nudge went out, so a reader was told; failing to say so only means the next fire nudges again.
    // That is the survivable direction, but it is still a fact worth a line rather than a silence.
    tally.errors += 1
    console.error('[inkstone] push fan-out could not mark its own rows:', errorDetail(error))
  }
}

/**
 * What one sweep has delivered and not yet announced, held per account.
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

/**
 * How long a delivered notification stays worth a late nudge.
 *
 * The fires are at :00, :15 and :45, so the gap a killed process has to survive is half an hour; three hours
 * is six of those, long enough that a reader whose deployment was restarting still hears about the morning's
 * digest, and short enough that nobody is woken for news a day old. It stays inside the message's own `TTL`
 * in `push.ts`, which is the other half of the bound: a nudge the push service may still be sitting on when
 * the window closes would arrive as a surprise about something that stopped being news.
 */
export const PUSH_CATCHUP_WINDOW_MS = 3 * 60 * 60 * 1000

/** Accounts one fire works off: the same bounded-backlog shape as `DUE_SWEEP_LIMIT`. */
export const PUSH_CATCHUP_ACCOUNTS_PER_FIRE = 20

/** Rows of one account one fire names in a nudge, so one reader's restored history cannot crowd out the rest. */
const PUSH_CATCHUP_ROWS_PER_ACCOUNT = 20

/**
 * The cron's half of Web Push: say again what no fan-out ever got said, and let the services prune the
 * devices that are gone.
 *
 * The immediate path is the delivery path; this one exists for the two ways it does not happen — a send that
 * every device refused, and a sweep killed between writing the row and handing over the sends. It is the
 * same walk `flushPushFanout` does, over rows read back out of `chat_notifications` instead of rows the tick
 * produced, which is what keeps the payload rules (a signal and a count, nothing of the reader's) in one
 * place rather than in two that can drift.
 *
 * **Idempotent by `pushed_at`.** A row is stamped the first time a push service accepts it, and a row that
 * was accepted is never a candidate again; the row's own `created_at` has to be inside the window and the
 * reader has still to have left it unread. The alternatives were tested against what they cost: `read_at`
 * alone says what the reader has seen, not whether anybody was told, so a row they have not opened would be
 * announced again on every fire for three hours; a window rule alone cannot tell a notification the sweep
 * already announced from one the process died before announcing, which is the duplicate the task forbids.
 * There is no second ledger of announced ids to keep in step either — the fact belongs on the row it
 * describes, or it goes out of date the moment the row is deleted or read.
 *
 * The clean-up of dead devices is not a separate sweep, because the server has no signal that an endpoint is
 * dead except a push service saying so: `sendPush` deletes the row on 404 and 410, the store drops it after
 * five refusals, and this fire is what reaches the devices an immediate fan-out never got to ask. Deleting a
 * subscription that has merely been quiet would take push away from a reader whose routines have not fired
 * this week, which is the worse failure.
 *
 * Refusals are logged and counted where they happen and the row's `last_error` keeps them, so nothing here
 * is swallowed; the tally is the return value, and the caller that wants the numbers awaits it.
 */
export async function runPushCatchUp(env: Env, now = Date.now()): Promise<PushFanoutTally> {
  const tally = newPushFanoutTally()
  const problem = vapidProblem(env)
  if (problem) {
    // Nothing is looked at and nothing is said, so nothing is counted: this fire's whole answer is the
    // sentence naming the secret to set.
    tally.configuration = problem
    return tally
  }
  const sinceAt = now - PUSH_CATCHUP_WINDOW_MS
  let accounts: string[]
  try {
    accounts = await accountsWithUnpushedNotifications(env.DB, sinceAt, PUSH_CATCHUP_ACCOUNTS_PER_FIRE)
  } catch (error) {
    tally.errors += 1
    console.error('[inkstone] push catch-up could not find the accounts behind:', errorDetail(error))
    return tally
  }
  for (const userId of accounts) {
    let ids: string[]
    try {
      ids = await new AssistantStore(env.DB, userId, env).listUnpushedNotificationIds(sinceAt, PUSH_CATCHUP_ROWS_PER_ACCOUNT)
    } catch (error) {
      tally.errors += 1
      console.error('[inkstone] push catch-up could not read one account\'s rows:', errorDetail(error))
      continue
    }
    // A row the candidate list named and this read did not is a row that got read or announced in between,
    // which is not a thing to count as a nudge nobody needed.
    if (!ids.length) continue
    await nudgeAccount(env, userId, ids, tally)
  }
  return tally
}

/** An exception's own words, never a stack, and never anything the sender did not already redact. */
function errorDetail(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200)
}

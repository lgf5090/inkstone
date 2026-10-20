/**
 * Fan-out: one message, every channel that is switched on, and one result per channel.
 *
 * `allSettled` rather than `all` is the whole design. Eight channels that work must not be taken down
 * by the ninth that does not, and a rejection that escaped here would abort a sweep whose other
 * subscriptions have not been looked at yet.
 *
 * Nine of the ten are adapters because nine of the ten are HTTP requests carrying a credential. The
 * in-app channel is not, so it is named here instead of in `ADAPTERS`: it writes into the reader's own
 * database, which is what `account` is for and why every caller has to hand one over.
 */
import type { ChannelAdapter, ChannelPayload, ChannelResult, SendContext } from '@shared/subscriptions/channels'
import type { ChannelKind } from '@shared/subscriptions/model'
import { notifyCopy } from '@shared/subscriptions/notify-copy'
import { ADAPTERS } from './adapters'
import { sendInApp, type DeliveryAccount } from './inapp'

const BY_KIND = new Map<ChannelKind, ChannelAdapter>(ADAPTERS.map((adapter) => [adapter.kind, adapter]))

export interface DispatchTarget {
  kind: ChannelKind
  config: Record<string, unknown>
}

export interface DispatchResult {
  attempted: number
  successCount: number
  failedCount: number
  results: ChannelResult[]
}

export async function dispatch(
  payload: ChannelPayload,
  targets: readonly DispatchTarget[],
  context: SendContext,
  account: DeliveryAccount,
): Promise<DispatchResult> {
  if (targets.length === 0) {
    return { attempted: 0, successCount: 0, failedCount: 0, results: [] }
  }
  const settled = await Promise.allSettled(targets.map(async (target) => {
    if (target.kind === 'inapp') return sendInApp(payload, account)
    const adapter = BY_KIND.get(target.kind)
    if (!adapter) {
      return { success: false, channel: target.kind, error: 'Unknown channel' } satisfies ChannelResult
    }
    return adapter.send(payload, target.config, context)
  }))

  const results = settled.map((entry, index) => entry.status === 'fulfilled'
    ? entry.value
    : { success: false, channel: targets[index]!.kind, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) })

  const successCount = results.filter((result) => result.success).length
  return {
    attempted: results.length,
    successCount,
    failedCount: results.length - successCount,
    results,
  }
}

/** Send one test message through one channel, using the copy the account reads in. */
export async function testChannel(
  kind: ChannelKind,
  config: Record<string, unknown>,
  context: SendContext,
  account: DeliveryAccount,
): Promise<ChannelResult> {
  const copy = notifyCopy(context.locale)
  const payload = { title: copy.testTitle, content: copy.testContent }
  try {
    if (kind === 'inapp') return await sendInApp(payload, account)
    const adapter = BY_KIND.get(kind)
    if (!adapter) return { success: false, channel: kind, error: 'Unknown channel' }
    return await adapter.send(payload, config, context)
  } catch (error) {
    return { success: false, channel: kind, error: error instanceof Error ? error.message : String(error) }
  }
}

export { ADAPTERS }
export type { DeliveryAccount }

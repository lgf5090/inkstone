/**
 * Fan-out: one message, every channel that is switched on, and one result per channel.
 *
 * `allSettled` rather than `all` is the whole design. Eight channels that work must not be taken down
 * by the ninth that does not, and a rejection that escaped here would abort a sweep whose other
 * subscriptions have not been looked at yet.
 */
import type { ChannelAdapter, ChannelPayload, ChannelResult, SendContext } from '@shared/subscriptions/channels'
import type { ChannelKind } from '@shared/subscriptions/model'
import { notifyCopy } from '@shared/subscriptions/notify-copy'
import { ADAPTERS } from './adapters'

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
): Promise<DispatchResult> {
  if (targets.length === 0) {
    return { attempted: 0, successCount: 0, failedCount: 0, results: [] }
  }
  const settled = await Promise.allSettled(targets.map(async (target) => {
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
): Promise<ChannelResult> {
  const copy = notifyCopy(context.locale)
  const adapter = BY_KIND.get(kind)
  if (!adapter) return { success: false, channel: kind, error: 'Unknown channel' }
  try {
    return await adapter.send({ title: copy.testTitle, content: copy.testContent }, config, context)
  } catch (error) {
    return { success: false, channel: kind, error: error instanceof Error ? error.message : String(error) }
  }
}

export { ADAPTERS }

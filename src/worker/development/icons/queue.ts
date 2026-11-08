import type { Env } from '../../env'
import { processJob } from './convert'

export interface IconQueueMessage {
  kind: 'convert'
  userId: string
  jobId: string
}

export function iconQueueAvailable(env: Env): boolean {
  return Boolean(env.ICONS_JOBS)
}

export async function enqueueIconJob(env: Env, userId: string, jobId: string): Promise<boolean> {
  if (!env.ICONS_JOBS) return false
  await env.ICONS_JOBS.send({ kind: 'convert', userId, jobId } satisfies IconQueueMessage)
  return true
}

/**
 * The queue consumer.
 *
 * Each message advances one bounded chunk. When items remain the consumer enqueues the next message
 * instead of looping inside one invocation, so a 500-item job never risks the consumer's wall clock.
 */
export async function handleIconQueue(batch: MessageBatch<IconQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { status, pending } = await processJob(env, message.body.userId, message.body.jobId)
      if (pending > 0 && status === 'running') {
        await env.ICONS_JOBS?.send(message.body)
      }
      message.ack()
    } catch (error) {
      console.warn('[inkstone] icon conversion message failed:', error)
      message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) })
    }
  }
}

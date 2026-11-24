import type { Env } from '../env'
import { AssistantStore } from '../assistant/store'
import { flushPushFanout } from '../assistant/push-fanout'

export async function createEmailNotification(
  env: Env,
  userId: string,
  input: { title: string; body: string; link?: string },
  ctx?: ExecutionContext,
): Promise<string> {
  const notification = await new AssistantStore(env.DB, userId, env).createNotification(input)
  const push = flushPushFanout(env, new Map([[userId, [notification.id]]])).catch((error) => {
    console.error('[inkstone] email notification push failed:', error)
  })
  if (ctx) ctx.waitUntil(push)
  else await push
  return notification.id
}

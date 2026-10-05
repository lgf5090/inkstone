import type { Context } from 'hono'
import { currentCursor, recordChange, type ChangeEntity, type ChangeOp } from '../db/writes'
import { drainFtsQueue, FTS_DRAIN_DELAY_MS } from '../db/fts'
import { notifySyncHub } from '../realtime/sync-hub'
import type { AppBindings } from '../env'

interface ScheduledFtsDrain {
  max: number
  rerun: boolean
  promise: Promise<void>
}

const scheduledFtsDrains = new WeakMap<D1Database, Map<string, ScheduledFtsDrain>>()


export function originOf(c: Context<AppBindings>): string | null {
  return c.req.header('X-Inkstone-Origin')?.slice(0, 128) || null
}


export async function commitChange(
  c: Context<AppBindings>,
  entity: ChangeEntity,
  entityId: string,
  op: ChangeOp,
): Promise<number> {
  const userId = c.get('userId')
  const cursor = await recordChange(c.env.DB, userId, entity, entityId, op)
  c.executionCtx?.waitUntil(notifySyncHub(c.env.SYNC_HUB, userId, cursor, originOf(c), c.env.DO_AUTH_KEY))
  return cursor
}


export async function broadcastCursor(
  c: Context<AppBindings>,
  knownCursor?: number,
): Promise<number> {
  const userId = c.get('userId')
  return broadcastUserCursor(
    c.env,
    userId,
    originOf(c),
    knownCursor,
    (task) => c.executionCtx?.waitUntil(task),
  )
}

export async function broadcastUserCursor(
  env: AppBindings['Bindings'],
  userId: string,
  origin: string | null = null,
  knownCursor?: number,
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<number> {
  const cursor = knownCursor ?? (await currentCursor(env.DB, userId))
  const notification = notifySyncHub(env.SYNC_HUB, userId, cursor, origin, env.DO_AUTH_KEY)
  if (waitUntil) waitUntil(notification)
  else await notification
  return cursor
}

export function scheduleFtsDrain(c: Context<AppBindings>, max = 5): void {
  if (!c.get('database').ftsEnabled || !c.executionCtx) return
  const userId = c.get('userId')
  const db = c.env.DB
  let byUser = scheduledFtsDrains.get(db)
  if (!byUser) {
    byUser = new Map()
    scheduledFtsDrains.set(db, byUser)
  }
  const existing = byUser.get(userId)
  if (existing) {
    existing.max = Math.max(existing.max, max)
    existing.rerun = true
    return
  }

  const scheduled: ScheduledFtsDrain = {
    max,
    rerun: false,
    promise: Promise.resolve(),
  }
  scheduled.promise = new Promise<void>((resolve) => {
    setTimeout(resolve, FTS_DRAIN_DELAY_MS + 2_000)
  })
    .then(async () => {
      do {
        scheduled.rerun = false
        await drainFtsQueue(db, userId, scheduled.max, true)
      } while (scheduled.rerun)
    })
    .catch(() => {})
    .finally(() => {
      if (byUser!.get(userId) === scheduled) byUser!.delete(userId)
    })
  byUser.set(userId, scheduled)
  c.executionCtx.waitUntil(scheduled.promise)
}

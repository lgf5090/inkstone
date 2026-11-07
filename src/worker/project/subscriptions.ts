/**
 * Following a board or a card. A subscription is the caller's own row keyed by (block, subscriber),
 * so re-following revives a soft-deleted row rather than duplicating it, and unfollowing only ever
 * touches the caller's own subscription. Notification delivery reads these rows separately (D-16).
 */
import type { ProjectSubscription, ProjectSubscriptionBlock } from '@shared/project/model'

interface SubscriptionRow {
  block_type: string
  block_id: string
  subscriber_id: string
  notified_at: number
  create_at: number
  delete_at: number
}

function rowToSubscription(row: SubscriptionRow): ProjectSubscription {
  return {
    blockType: row.block_type as ProjectSubscriptionBlock,
    blockId: row.block_id,
    subscriberId: row.subscriber_id,
    notifiedAt: row.notified_at,
    createAt: row.create_at,
  }
}

export async function listProjectSubscriptions(db: D1Database, userId: string): Promise<ProjectSubscription[]> {
  const { results } = await db
    .prepare('SELECT * FROM project_subscriptions WHERE subscriber_id = ?1 AND delete_at = 0 ORDER BY create_at DESC, block_id')
    .bind(userId)
    .all<SubscriptionRow>()
  return results.map(rowToSubscription)
}

export async function subscribeProject(
  db: D1Database,
  userId: string,
  blockType: ProjectSubscriptionBlock,
  blockId: string,
  now: number,
): Promise<ProjectSubscription> {
  await db.prepare(
    `INSERT INTO project_subscriptions (block_type, block_id, subscriber_id, notified_at, create_at, delete_at)
     VALUES (?1, ?2, ?3, 0, ?4, 0)
     ON CONFLICT(block_id, subscriber_id) DO UPDATE SET block_type = excluded.block_type, delete_at = 0`,
  ).bind(blockType, blockId, userId, now).run()
  const row = await db
    .prepare('SELECT * FROM project_subscriptions WHERE block_id = ?1 AND subscriber_id = ?2')
    .bind(blockId, userId)
    .first<SubscriptionRow>()
  return rowToSubscription(row!)
}

export async function unsubscribeProject(db: D1Database, userId: string, blockId: string, now: number): Promise<void> {
  await db
    .prepare('UPDATE project_subscriptions SET delete_at = ?1 WHERE block_id = ?2 AND subscriber_id = ?3 AND delete_at = 0')
    .bind(now, blockId, userId)
    .run()
}
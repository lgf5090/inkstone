/**
 * Card due reminders (F-10), fired from the shared every-minute cron. A date property whose `from`
 * falls inside the next day reminds the card's subscribers once; `notified_at` is the dedupe stamp so
 * a per-minute sweep never repeats a reminder. The scan is bounded per fire so one cron tick stays cheap.
 */
import type { AppBindings } from '../env'
import { notifySyncHub } from '../realtime/sync-hub'
import { recordProjectActivity } from './enhance'
import { notifyProjectReminder } from './notify'

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000
const SCAN_LIMIT = 500
const MAX_REMINDER_SUBSCRIBERS = 100

interface ReminderRow {
  card_id: string
  property_id: string
  due_at: number
  board_id: string
  title: string
}

/** The activity log is a recent-history surface, not an audit archive; keep half a year. */
export const PROJECT_ACTIVITY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

export async function pruneProjectActivity(env: AppBindings['Bindings'], now: number): Promise<number> {
  const result = await env.DB
    .prepare('DELETE FROM project_activity WHERE created_at < ?1')
    .bind(now - PROJECT_ACTIVITY_RETENTION_MS)
    .run()
  return result.meta.changes ?? 0
}

export async function sweepProjectReminders(env: AppBindings['Bindings'], now: number, waitUntil?: (task: Promise<unknown>) => void): Promise<number> {
  const { results } = await env.DB
    .prepare(
      `SELECT r.card_id, r.property_id, r.due_at, r.board_id, c.title FROM project_reminders r
       JOIN project_cards c ON c.id = r.card_id AND c.delete_at = 0
       JOIN project_boards b ON b.id = r.board_id AND b.delete_at = 0 AND b.archived = 0
       WHERE r.notified_at = 0 AND r.due_at <= ?1
         AND EXISTS (SELECT 1 FROM project_subscriptions s
                     WHERE s.block_type = 'card' AND s.block_id = r.card_id AND s.delete_at = 0)
       ORDER BY r.due_at, r.card_id, r.property_id
       LIMIT ?2`,
    )
    .bind(now + REMINDER_WINDOW_MS, SCAN_LIMIT)
    .all<ReminderRow>()
  let reminded = 0
  let processedSubscribers = 0
  for (const row of results) {
    const { results: subs } = await env.DB
      .prepare('SELECT subscriber_id FROM project_subscriptions WHERE block_type = ?1 AND block_id = ?2 AND delete_at = 0')
      .bind('card', row.card_id)
      .all<{ subscriber_id: string }>()
    if (processedSubscribers + subs.length > MAX_REMINDER_SUBSCRIBERS) break
    processedSubscribers += subs.length
    const delivered = await notifyProjectReminder(env.DB, env, {
      boardId: row.board_id,
      cardId: row.card_id,
      propertyId: row.property_id,
      dueAt: row.due_at,
      cardTitle: row.title,
      subscriberIds: subs.map((sub) => sub.subscriber_id),
    })
    if (delivered.length === 0) {
      await env.DB.prepare('UPDATE project_reminders SET notified_at = ?1 WHERE card_id = ?2 AND property_id = ?3 AND due_at = ?4')
        .bind(now, row.card_id, row.property_id, row.due_at).run()
      continue
    }
    reminded += 1
    const tasks = delivered.map((subscriberId) => notifySyncHub(env.SYNC_HUB, subscriberId, now, null, env.DO_AUTH_KEY))
    const all = Promise.all(tasks).then(() => undefined)
    if (waitUntil) waitUntil(all)
    else await all
    await env.DB.batch([
      env.DB.prepare('UPDATE project_reminders SET notified_at = ?1 WHERE card_id = ?2 AND property_id = ?3 AND due_at = ?4')
        .bind(now, row.card_id, row.property_id, row.due_at),
      env.DB.prepare('UPDATE project_subscriptions SET notified_at = ?1 WHERE block_type = ?2 AND block_id = ?3 AND delete_at = 0')
        .bind(row.due_at, 'card', row.card_id),
    ])
    await recordProjectActivity(env.DB, row.board_id, 'system', 'reminder', row.card_id, 'card due soon', now)
  }
  return reminded
}
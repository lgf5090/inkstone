/**
 * Card due reminders (F-10), fired from the shared every-minute cron. A date property whose `from`
 * falls inside the next day reminds the card's subscribers once; `notified_at` is the dedupe stamp so
 * a per-minute sweep never repeats a reminder. The scan is bounded per fire so one cron tick stays cheap.
 */
import type { AppBindings } from '../env'
import { notifySyncHub } from '../realtime/sync-hub'
import { recordProjectActivity } from './enhance'

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000
const SCAN_LIMIT = 500

interface DateValueRow {
  card_id: string
  value: string
  board_id: string
}

export async function sweepProjectReminders(env: AppBindings['Bindings'], now: number, waitUntil?: (task: Promise<unknown>) => void): Promise<number> {
  const { results } = await env.DB
    .prepare(
      `SELECT v.card_id, v.value, c.board_id FROM project_card_values v
       JOIN project_cards c ON c.id = v.card_id AND c.delete_at = 0
       JOIN project_properties p ON p.id = v.property_id AND p.board_id = c.board_id AND p.type = 'date'
       WHERE COALESCE(json_extract(v.value, '$.from'), CAST(v.value AS INTEGER)) BETWEEN ?1 AND ?2
       ORDER BY COALESCE(json_extract(v.value, '$.from'), CAST(v.value AS INTEGER))
       LIMIT ?3`,
    )
    .bind(now, now + REMINDER_WINDOW_MS, SCAN_LIMIT)
    .all<DateValueRow>()
  let reminded = 0
  for (const row of results) {
    let from: number | undefined
    try {
      from = (JSON.parse(row.value) as { from?: number }).from
    } catch {
      const stamp = Number(row.value)
      if (Number.isFinite(stamp)) from = stamp
    }
    if (typeof from !== 'number' || from < now || from > now + REMINDER_WINDOW_MS) continue
    const { results: subs } = await env.DB
      .prepare('SELECT subscriber_id FROM project_subscriptions WHERE block_type = ?1 AND block_id = ?2 AND delete_at = 0 AND notified_at < ?3')
      .bind('card', row.card_id, from)
      .all<{ subscriber_id: string }>()
    if (subs.length === 0) continue
    reminded += 1
    const tasks = subs.map((sub) => notifySyncHub(env.SYNC_HUB, sub.subscriber_id, now, null, env.DO_AUTH_KEY))
    const all = Promise.all(tasks).then(() => undefined)
    if (waitUntil) waitUntil(all)
    else await all
    await env.DB.prepare('UPDATE project_subscriptions SET notified_at = ?1 WHERE block_type = ?2 AND block_id = ?3 AND delete_at = 0').bind(from, 'card', row.card_id).run()
    await recordProjectActivity(env.DB, row.board_id, 'system', 'reminder', row.card_id, 'card due soon', now)
  }
  return reminded
}
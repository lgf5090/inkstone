/**
 * The minute sweep that delivers due task reminders.
 *
 * A reminder is a fact about a row (`remind_at`) and a fact about whether it has been said
 * (`reminded_at`), so the sweep needs no scheduler of its own: it asks the table what is due and marks
 * what it delivered. That is also what makes it safe to run on every cron fire — the claim is a
 * conditional UPDATE, so two overlapping ticks cannot both deliver the same reminder, and a fire that
 * arrives a minute late still delivers rather than skipping to the next hour.
 *
 * The delivery is a row in `chat_notifications`, which is the record the reader's notification list
 * shows; the Web Push nudge that follows is a courtesy, handed off so a push service that answers slowly
 * cannot hold up the tick. Neither can fail the tick: one account's broken settings must not stop the
 * others, so every row is swept inside its own try.
 */

import { normalizeAssistantSettings, type AssistantSettings } from '@shared/assistant'
import { EN_US_TODO_NOTIFY } from '../../shared/locales/en-US-todo-notify'
import { ZH_CN_TODO_NOTIFY } from '../../shared/locales/zh-CN-todo-notify'
import type { Env } from '../env'
import { AssistantStore } from './store'
import { newPushFanoutTally, NotificationPushFanout, type PushFanoutTally } from './push-fanout'

/** How many reminders one fire will deliver, so a backlog cannot monopolise the tick. */
export const REMINDER_SWEEP_LIMIT = 50

export interface TaskReminderSweepResult {
  /** Reminders this fire found due. */
  due: number
  /** Rows it actually claimed and delivered — a second tick over the same reminder claims none. */
  sent: number
  /** Rows another tick had already claimed. */
  claimed: number
  failed: number
  /** What the nudges cost, once they were sent. See `SweepResult.push` in `scheduler.ts`. */
  push: Promise<PushFanoutTally>
}

type WaitUntil = (task: Promise<unknown>) => void

interface DueReminder {
  user_id: string
  id: string
  title: string
  due_at: number | null
}

/** The catalog for the account's own language; the sweep has no request to ask. */
function copyFor(language: AssistantSettings['language']) {
  return language === 'en-US' ? EN_US_TODO_NOTIFY : ZH_CN_TODO_NOTIFY
}

/** The two placeholders these sentences carry, filled without pulling the interface's formatter in. */
function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}

/** A due time as the reader would read it, in their own zone. */
function whenText(dueAt: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(dueAt))
  } catch {
    return new Date(dueAt).toISOString().slice(0, 16).replace('T', ' ')
  }
}

export async function sweepTaskReminders(
  env: Env,
  now = Date.now(),
  waitUntil?: WaitUntil,
): Promise<TaskReminderSweepResult> {
  const { results } = await env.DB.prepare(
    `SELECT user_id, id, title, due_at FROM todos_tasks
      WHERE reminded_at IS NULL AND remind_at IS NOT NULL AND remind_at <= ?1 AND status != 'done'
      ORDER BY remind_at ASC LIMIT ?2`,
  ).bind(now, REMINDER_SWEEP_LIMIT).all<DueReminder>()

  const fanout = new NotificationPushFanout(env)
  let sent = 0
  let claimed = 0
  let failed = 0
  // One store per account, made once: a backlog of twenty reminders for the same reader is one settings
  // read, not twenty.
  const stores = new Map<string, AssistantStore>()

  for (const row of results) {
    try {
      // The claim is the delivery gate. `changes === 0` means another fire got here first, which is the
      // ordinary case on a deployment whose cron overlaps, not an error.
      const claim = await env.DB.prepare(
        `UPDATE todos_tasks SET reminded_at = ?3
          WHERE user_id = ?1 AND id = ?2 AND reminded_at IS NULL AND remind_at IS NOT NULL AND status != 'done'`,
      ).bind(row.user_id, row.id, now).run()
      if ((claim.meta.changes ?? 0) === 0) {
        claimed++
        continue
      }
      let store = stores.get(row.user_id)
      if (!store) {
        store = new AssistantStore(env.DB, row.user_id, env)
        stores.set(row.user_id, store)
      }
      const settings = normalizeAssistantSettings(await store.getSettings())
      const copy = copyFor(settings.language)
      const body = row.due_at === null ? copy.noDue : fill(copy.due, { when: whenText(row.due_at, settings.timezone) })
      const notification = await store.createNotification({ title: `${copy.title} · ${row.title}`, body })
      fanout.track(row.user_id, notification.id)
      sent++
    } catch (error) {
      failed++
      console.error('[inkstone] task reminder failed:', error instanceof Error ? error.message : error)
    }
  }

  const push = fanout.empty ? Promise.resolve(newPushFanoutTally()) : fanout.flush()
  if (waitUntil) waitUntil(push)
  else await push
  return { due: results.length, sent, claimed, failed, push }
}

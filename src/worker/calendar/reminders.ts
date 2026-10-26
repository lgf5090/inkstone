/**
 * The minute sweep that delivers calendar reminders.
 *
 * The reminder is the reader's account-wide lead time, so there is no per-event row to keep in sync:
 * the sweep asks only accounts that opted in, loads the next `lead` minutes (plus a small grace for a
 * late tick), expands recurring series, and claims each occurrence in `calendar_reminder_fires`.
 * The claim is the delivery gate; the notification row is the delivery, and the push is a courtesy.
 */
import { normalizeCalendarPreferences } from '@shared/calendar/model'
import type { CalendarEventDto } from '@shared/calendar/model'
import type { Env } from '../env'
import { EN_US_CALENDAR_NOTIFY } from '@shared/locales/en-US-calendar-notify'
import { ZH_CN_CALENDAR_NOTIFY } from '@shared/locales/zh-CN-calendar-notify'
import { AssistantStore } from '../assistant/store'
import { newPushFanoutTally, NotificationPushFanout, type PushFanoutTally } from '../assistant/push-fanout'
import { CalendarStore } from './store'
import { expandRecurringEvents } from './ics'
import { temporalValueToEpochMs } from '@shared/calendar/model'

const REMINDER_GRACE_MS = 5 * 60 * 1000
const SWEEP_LIMIT = 50
const FIRE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface CalendarReminderSweepResult {
  due: number
  sent: number
  claimed: number
  failed: number
  push: Promise<PushFanoutTally>
}

type WaitUntil = (task: Promise<unknown>) => void

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
}

function whenText(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
}

function dateKey(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

function occurrenceStarts(
  event: CalendarEventDto,
  from: number,
  to: number,
  timeZone: string,
): number[] {
  if (!event.recurrenceRule) {
    const start = temporalValueToEpochMs(event.start, timeZone)
    return start >= from && start <= to ? [start] : []
  }
  const starts: number[] = []
  try {
    const expansion = expandRecurringEvents([event], from, to, timeZone)
    for (const occurrence of expansion.occurrences) {
      starts.push(temporalValueToEpochMs(occurrence.start, timeZone))
    }
  } catch {
    // A malformed rule leaves the master's own start below; the sweep must not fail the whole tick.
  }
  const master = temporalValueToEpochMs(event.start, timeZone)
  if (master >= from && master <= to) starts.push(master)
  return [...new Set(starts)]
}

export async function sweepCalendarReminders(
  env: Env,
  now = Date.now(),
  waitUntil?: WaitUntil,
): Promise<CalendarReminderSweepResult> {
  const { results: accounts } = await env.DB.prepare(
    `SELECT user_id, preferences_json FROM calendar_preferences`,
  ).all<{ user_id: string; preferences_json: string }>()

  const fanout = new NotificationPushFanout(env)
  const stores = new Map<string, AssistantStore>()
  const settingsCache = new Map<string, Awaited<ReturnType<AssistantStore['getSettings']>>>()
  let due = 0
  let sent = 0
  let claimed = 0
  let failed = 0

  for (const account of accounts) {
    let preferences
    try {
      preferences = normalizeCalendarPreferences(JSON.parse(account.preferences_json))
    } catch {
      continue
    }
    const minutes = preferences.eventReminderMinutes
    if (minutes <= 0) continue
    const leadMs = minutes * 60_000
    const from = now - REMINDER_GRACE_MS
    const to = now + leadMs + 60_000
    let events: CalendarEventDto[]
    try {
      const store = new CalendarStore(env.DB, account.user_id)
      events = (await store.listEvents(from, to)).events
    } catch (error) {
      console.error('[inkstone] calendar reminder range failed:', error instanceof Error ? error.message : error)
      continue
    }
    for (const event of events) {
      const starts = occurrenceStarts(event, from, to, preferences.timeZone)
      for (const start of starts) {
        const remindAt = start - leadMs
        if (remindAt > now || remindAt < now - REMINDER_GRACE_MS) continue
        due++
        if (sent + claimed >= SWEEP_LIMIT) break
        try {
          const claim = await env.DB.prepare(
            `INSERT OR IGNORE INTO calendar_reminder_fires
              (user_id, event_id, occurrence_start_ms, fired_at)
             VALUES (?1, ?2, ?3, ?4)`,
          ).bind(account.user_id, event.id, start, now).run()
          if ((claim.meta.changes ?? 0) === 0) {
            claimed++
            continue
          }
          let store = stores.get(account.user_id)
          if (!store) {
            store = new AssistantStore(env.DB, account.user_id, env)
            stores.set(account.user_id, store)
          }
          let settings = settingsCache.get(account.user_id)
          if (!settings) {
            settings = await store.getSettings()
            settingsCache.set(account.user_id, settings)
          }
          const copy = settings.language === 'en-US' ? EN_US_CALENDAR_NOTIFY : ZH_CN_CALENDAR_NOTIFY
          const notification = await store.createNotification({
            title: `${copy.title} · ${event.title}`,
            body: fill(copy.startsAt, { title: event.title, when: whenText(start, settings.timezone) }),
            link: `calendar:${dateKey(start, settings.timezone)}`,
          })
          fanout.track(account.user_id, notification.id)
          sent++
        } catch (error) {
          failed++
          console.error('[inkstone] calendar reminder failed:', error instanceof Error ? error.message : error)
        }
      }
      if (sent + claimed >= SWEEP_LIMIT) break
    }
    if (sent + claimed >= SWEEP_LIMIT) break
  }

  // The fire log only needs to outlive a late tick; pruning is best-effort and must not fail delivery.
  await env.DB.prepare('DELETE FROM calendar_reminder_fires WHERE fired_at < ?1')
    .bind(now - FIRE_RETENTION_MS).run().catch((error: unknown) => {
      console.warn('[inkstone] calendar reminder cleanup failed:', error instanceof Error ? error.message : error)
    })

  const push = fanout.empty ? Promise.resolve(newPushFanoutTally()) : fanout.flush()
  if (waitUntil) waitUntil(push)
  else await push
  return { due, sent, claimed, failed, push }
}

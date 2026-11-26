/**
 * The minute sweep that delivers calendar reminders.
 *
 * An event carries its own leads, and falls back to the account-wide one when it names none. The sweep
 * loads the window the account actually uses, expands recurring series, and records each delivered
 * (occurrence, lead) pair in `calendar_reminder_fires`. The notification row is written before that
 * idempotency record is confirmed, so a failed write remains retryable; the push is a courtesy.
 */
import ICAL from 'ical.js'
import { Temporal } from 'temporal-polyfill'
import { MAX_REMINDER_MINUTES, MAX_RECURRENCE_RULE, normalizeCalendarPreferences, temporalValueToEpochMs } from '@shared/calendar/model'
import type { CalendarEventDto } from '@shared/calendar/model'
import type { Env } from '../env'
import { EN_US_CALENDAR_NOTIFY } from '@shared/locales/en-US-calendar-notify'
import { ZH_CN_CALENDAR_NOTIFY } from '@shared/locales/zh-CN-calendar-notify'
import { AssistantStore } from '../assistant/store'
import { newPushFanoutTally, NotificationPushFanout, type PushFanoutTally } from '../assistant/push-fanout'
import { envEmailDomains, readEmailDeployment } from '../email/deployment'
import { sendViaProvider } from '../email/outbound'
import { CalendarStore } from './store'
import { expandRecurringEvents } from './ics'

const REMINDER_GRACE_MS = 5 * 60 * 1000
const SWEEP_LIMIT = 50
const FIRE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const RECURRENCE_FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const ALL_DAY_REMINDER_HOUR = 9

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

function errorDetail(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200)
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

function allDayReminderStart(value: string, timeZone: string): number {
  const date = Temporal.PlainDate.from(value)
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.year, month: date.month, day: date.day,
    hour: ALL_DAY_REMINDER_HOUR, minute: 0, second: 0, millisecond: 0,
  }).toInstant().epochMilliseconds
}

function occurrenceStarts(
  event: CalendarEventDto,
  from: number,
  to: number,
  timeZone: string,
): number[] {
  const master = event.allDay
    ? allDayReminderStart(event.start.value, timeZone)
    : temporalValueToEpochMs(event.start, timeZone)
  if (!event.recurrenceRule) return master >= from && master <= to ? [master] : []
  const starts: number[] = []
  try {
    const rule = event.recurrenceRule.replace(/^RRULE:/i, '').trim()
    if (rule.length > MAX_RECURRENCE_RULE) throw new Error('Recurrence rule is too long')
    const recurrence = ICAL.Recur.fromString(rule)
    if (!RECURRENCE_FREQUENCIES.has(recurrence.freq)) throw new Error('Recurrence rule has no supported frequency')
    const expansion = expandRecurringEvents([event], from, to, timeZone)
    for (const occurrence of expansion.occurrences) {
      starts.push(occurrence.allDay
        ? allDayReminderStart(occurrence.start.value, timeZone)
        : temporalValueToEpochMs(occurrence.start, timeZone))
    }
  } catch (error) {
    // A malformed rule leaves the master's own start below; the sweep must not fail the whole tick.
    console.error('[inkstone] calendar reminder recurrence rule failed:', event.id, errorDetail(error))
  }
  if (master >= from && master <= to) starts.push(master)
  return [...new Set(starts)]
}

export async function sweepCalendarReminders(
  env: Env,
  now = Date.now(),
  waitUntil?: WaitUntil,
): Promise<CalendarReminderSweepResult> {
  const { results: accounts } = await env.DB.prepare(
    `SELECT a.user_id, a.preferences_json,
            COALESCE(MAX(CASE WHEN r.minutes BETWEEN 0 AND ?1 THEN r.minutes END), 0) AS lead,
            COUNT(r.minutes) AS reminder_count
       FROM (
         SELECT user_id, preferences_json FROM calendar_preferences
         UNION
         SELECT DISTINCT r.user_id, p.preferences_json
           FROM calendar_event_reminders r
           LEFT JOIN calendar_preferences p ON p.user_id = r.user_id
       ) a
       LEFT JOIN calendar_event_reminders r ON r.user_id = a.user_id
      GROUP BY a.user_id, a.preferences_json
      ORDER BY a.user_id`,
  ).bind(MAX_REMINDER_MINUTES).all<{
    user_id: string
    preferences_json: string | null
    lead: number
    reminder_count: number
  }>()

  const fanout = new NotificationPushFanout(env)
  const emailDeployment = await readEmailDeployment(env.DB).catch((error: unknown) => {
    console.error('[inkstone] calendar reminder email deployment read failed:', errorDetail(error))
    return null
  })
  const emailDomains = [...new Set([...envEmailDomains(env), ...(emailDeployment?.domains ?? [])])]
  const emailFrom = emailDeployment?.resendFrom.trim()
    || (emailDomains[0] ? `calendar@${emailDomains[0]}` : null)
  const stores = new Map<string, AssistantStore>()
  const settingsCache = new Map<string, Awaited<ReturnType<AssistantStore['getSettings']>>>()
  const preferencesByUser = new Map<string, ReturnType<typeof normalizeCalendarPreferences>>()
  let due = 0
  let sent = 0
  let claimed = 0
  let failed = 0

  for (const account of accounts) {
    let preferences: ReturnType<typeof normalizeCalendarPreferences>
    try {
      preferences = normalizeCalendarPreferences(
        account.preferences_json === null ? undefined : JSON.parse(account.preferences_json),
      )
    } catch (error) {
      console.error('[inkstone] calendar reminder preferences failed:', account.user_id, errorDetail(error))
      preferences = normalizeCalendarPreferences(undefined)
    }
    preferencesByUser.set(account.user_id, preferences)
    const minutes = preferences.eventReminderMinutes
    // The window is the furthest lead this account actually uses: an account with a 10-minute default
    // and no per-event reminders keeps scanning eleven minutes, not a week.
    const ownLeadMax = Number(account.lead ?? 0)
    const ownReminderCount = Number(account.reminder_count ?? 0)
    const leadMinutes = Math.max(minutes, ownLeadMax)
    // Zero is a real per-event lead (at start), and a corrupt lead still needs to reach the per-event
    // validation below so it is logged rather than making the whole account disappear.
    if (leadMinutes <= 0 && ownReminderCount === 0) continue
    const from = now - REMINDER_GRACE_MS
    const to = now + leadMinutes * 60_000 + 60_000
    let events: CalendarEventDto[]
    let ownReminders: Map<string, number[]>
    try {
      const store = new CalendarStore(env.DB, account.user_id)
      events = (await store.listEvents(from, to)).events
      ownReminders = await store.eventReminders(events.map((event) => event.id))
    } catch (error) {
      console.error('[inkstone] calendar reminder range failed:', account.user_id, errorDetail(error))
      continue
    }
    for (const event of events) {
      const eventLeads = ownReminders.get(event.id)
      const leads = eventLeads?.length
        ? eventLeads.filter((lead) => {
          if (Number.isInteger(lead) && lead >= 0 && lead <= MAX_REMINDER_MINUTES) return true
          console.error('[inkstone] calendar reminder rule failed:', account.user_id, event.id, `invalid lead ${String(lead)}`)
          return false
        })
        : minutes > 0 ? [minutes] : []
      const starts = occurrenceStarts(event, from, to, preferences.timeZone)
      for (const start of starts) {
        for (const lead of leads) {
          const remindAt = start - lead * 60_000
          if (remindAt > now || remindAt < now - REMINDER_GRACE_MS) continue
          due++
          if (sent >= SWEEP_LIMIT) break
          try {
            const fired = await env.DB.prepare(
              `SELECT 1 AS fired FROM calendar_reminder_fires
                WHERE user_id = ?1 AND event_id = ?2 AND occurrence_start_ms = ?3 AND minutes = ?4`,
            ).bind(account.user_id, event.id, start, lead).first<{ fired: number }>()
            if (fired) {
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
              body: fill(copy.startsAt, { title: event.title, when: whenText(start, preferences.timeZone) }),
              link: `calendar:${dateKey(start, preferences.timeZone)}`,
            })
            // Delivery must exist before its idempotency record. A failed notification write above leaves
            // no claim, so the next sweep retries instead of permanently losing the reminder.
            const claim = await env.DB.prepare(
              `INSERT OR IGNORE INTO calendar_reminder_fires
                (user_id, event_id, occurrence_start_ms, minutes, fired_at)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            ).bind(account.user_id, event.id, start, lead, now).run()
            if ((claim.meta.changes ?? 0) === 0) {
              // Another overlapping sweep won the claim after our pre-check. Keep its notification and
              // remove only the extra row this sweep created; email and push never see the loser.
              claimed++
              try {
                await env.DB.prepare('DELETE FROM chat_notifications WHERE user_id = ?1 AND id = ?2')
                  .bind(account.user_id, notification.id).run()
              } catch (error) {
                console.error('[inkstone] calendar reminder duplicate cleanup failed:', account.user_id, event.id, errorDetail(error))
              }
              continue
            }
            fanout.track(account.user_id, notification.id)
            if (preferences.emailReminders && preferences.reminderEmail && emailFrom) {
              const mail = sendViaProvider(env, account.user_id, {
                to: preferences.reminderEmail,
                from: emailFrom,
                subject: `${copy.title} · ${event.title}`,
                text: fill(copy.startsAt, { title: event.title, when: whenText(start, preferences.timeZone) }),
              }).catch((mailError: unknown) => {
                console.warn('[inkstone] calendar reminder email failed:', account.user_id, event.id, errorDetail(mailError))
              })
              if (waitUntil) waitUntil(mail)
              else await mail
            }
            sent++
          } catch (error) {
            failed++
            console.error('[inkstone] calendar reminder failed:', account.user_id, event.id, start, lead, errorDetail(error))
          }
        }
        if (sent >= SWEEP_LIMIT) break
      }
      if (sent >= SWEEP_LIMIT) break
    }
    if (sent >= SWEEP_LIMIT) break
  }

  // Snoozes are separate from leads: the reader asked for one more notification, not a new lead.
  const { results: dueSnoozes } = await env.DB.prepare(
    `SELECT s.user_id, s.id AS snooze_id, e.title, COALESCE(s.occurrence_start_ms, e.start_ms) AS start_ms
       FROM calendar_reminder_snoozes s
       JOIN calendar_events e ON e.user_id = s.user_id AND e.id = s.event_id
      WHERE s.notify_at <= ?1
      ORDER BY s.notify_at ASC
      LIMIT 50`,
  ).bind(now).all<{ user_id: string; snooze_id: string; title: string; start_ms: number }>()
  for (const row of dueSnoozes ?? []) {
    try {
      let store = stores.get(row.user_id)
      if (!store) {
        store = new AssistantStore(env.DB, row.user_id, env)
        stores.set(row.user_id, store)
      }
      let settings = settingsCache.get(row.user_id)
      if (!settings) {
        settings = await store.getSettings()
        settingsCache.set(row.user_id, settings)
      }
      const copy = settings.language === 'en-US' ? EN_US_CALENDAR_NOTIFY : ZH_CN_CALENDAR_NOTIFY
      const preferences = preferencesByUser.get(row.user_id) ?? normalizeCalendarPreferences(undefined)
      const start = Number(row.start_ms)
      const notification = await store.createNotification({
        title: `${copy.title} · ${row.title}`,
        body: fill(copy.startsAt, { title: row.title, when: whenText(start, preferences.timeZone) }),
        link: `calendar:${dateKey(start, preferences.timeZone)}`,
      })
      fanout.track(row.user_id, notification.id)
      if (preferences?.emailReminders && preferences.reminderEmail && emailFrom) {
        const mail = sendViaProvider(env, row.user_id, {
          to: preferences.reminderEmail,
          from: emailFrom,
          subject: `${copy.title} · ${row.title}`,
          text: fill(copy.startsAt, { title: row.title, when: whenText(start, preferences.timeZone) }),
        }).catch((mailError: unknown) => {
          console.warn('[inkstone] calendar snooze email failed:', mailError instanceof Error ? mailError.message : mailError)
        })
        if (waitUntil) waitUntil(mail)
        else await mail
      }
      await env.DB.prepare(
        'DELETE FROM calendar_reminder_snoozes WHERE user_id = ?1 AND id = ?2',
      ).bind(row.user_id, row.snooze_id).run()
      sent++
    } catch (error) {
      failed++
      console.error('[inkstone] calendar snooze failed:', error instanceof Error ? error.message : error)
    }
  }
  await env.DB.prepare('DELETE FROM calendar_reminder_snoozes WHERE notify_at < ?1')
    .bind(now - FIRE_RETENTION_MS).run().catch((error: unknown) => {
      console.warn('[inkstone] calendar snooze cleanup failed:', error instanceof Error ? error.message : error)
    })

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

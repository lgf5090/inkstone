// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { defaultCalendarPreferences } from '../src/shared/calendar/model'
import { AssistantStore } from '../src/worker/assistant/store'
import { CalendarStore } from '../src/worker/calendar/store'
import { sweepCalendarReminders } from '../src/worker/calendar/reminders'
import { EN_US_CALENDAR_NOTIFY } from '../src/shared/locales/en-US-calendar-notify'
import { ZH_CN_CALENDAR_NOTIFY } from '../src/shared/locales/zh-CN-calendar-notify'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-alice'
const OTHER_USER = 'user-bob'
let sqlite: DatabaseSync
let db: D1Database
let env: Env
let calendarId: string

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  env = { DB: db } as unknown as Env
  const store = new CalendarStore(db, USER)
  calendarId = (await store.ensureDefaultCalendar())[0]!.id
  await store.savePreferences({
    ...defaultCalendarPreferences(),
    timeZone: 'UTC',
    eventReminderMinutes: 10,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function createEvent(startMs: number, recurrenceRule?: string, userId = USER): Promise<string> {
  const start = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO('UTC').toString()
  const end = Temporal.Instant.fromEpochMilliseconds(startMs + 60 * 60 * 1000).toZonedDateTimeISO('UTC').toString()
  const store = new CalendarStore(db, userId)
  const ownCalendarId = userId === USER ? calendarId : (await store.ensureDefaultCalendar())[0]!.id
  const event = await store.createEvent({
    title: 'Design review',
    description: '',
    kind: 'event',
    task: null,
    conference: null,
    start: { value: start, type: 'zoned', timeZone: 'UTC' },
    end: { value: end, type: 'zoned', timeZone: 'UTC' },
    startMs,
    endMs: startMs + 60 * 60 * 1000,
    allDay: false,
    calendarIds: [ownCalendarId],
    meta: recurrenceRule ? { recurrenceRule } : {},
    icon: null,
    recurrenceRule: recurrenceRule ?? null,
    source: 'local',
    externalId: null,
  })
  return event.id
}

describe('calendar reminder copy', () => {
  it('keeps both languages aligned by key and placeholder', () => {
    expect(Object.keys(ZH_CN_CALENDAR_NOTIFY).sort()).toEqual(Object.keys(EN_US_CALENDAR_NOTIFY).sort())
    for (const key of Object.keys(EN_US_CALENDAR_NOTIFY) as Array<keyof typeof EN_US_CALENDAR_NOTIFY>) {
      const placeholders = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
      expect(placeholders(ZH_CN_CALENDAR_NOTIFY[key])).toEqual(placeholders(EN_US_CALENDAR_NOTIFY[key]))
    }
  })
})

describe('calendar reminders', () => {
  it('delivers once, links to the day, and ignores an already-fired occurrence', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await createEvent(now + 10 * 60_000)

    const first = await sweepCalendarReminders(env, now)
    expect(first).toMatchObject({ due: 1, sent: 1, claimed: 0, failed: 0 })
    const rows = sqlite.prepare('SELECT title, body, link FROM chat_notifications WHERE user_id = ?').all(USER) as Array<{
      title: string
      body: string
      link: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toContain('Design review')
    expect(rows[0]!.body).toContain('Design review')
    expect(rows[0]!.link).toBe('calendar:2026-10-26')

    const second = await sweepCalendarReminders(env, now)
    expect(second).toMatchObject({ sent: 0, claimed: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
  })

  it('expands a recurring series and respects an opted-out account', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await createEvent(now + 10 * 60_000, 'FREQ=WEEKLY;BYDAY=MO')
    expect((await sweepCalendarReminders(env, now)).sent).toBe(1)

    await new CalendarStore(db, USER).savePreferences({
      ...defaultCalendarPreferences(),
      timeZone: 'UTC',
      eventReminderMinutes: 0,
    })
    expect((await sweepCalendarReminders(env, now + 7 * 24 * 60 * 60 * 1000)).sent).toBe(0)
  })
})

describe('per-event reminders', () => {
  const store = () => new CalendarStore(db, USER)

  it('fires every lead an event carries, once each', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const id = await createEvent(now + 60 * 60_000)
    await store().setEventReminders(id, [60, 10], (await store().getEvent(id))!.rev)
    expect((await store().eventReminders([id])).get(id)).toEqual([10, 60])

    // An hour ahead of the start only the 60-minute lead is due; the 10-minute one fires later.
    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1 })
    expect(await sweepCalendarReminders(env, now + 50 * 60_000)).toMatchObject({ due: 1, sent: 1 })
    const again = await sweepCalendarReminders(env, now + 50 * 60_000)
    expect(again).toMatchObject({ sent: 0, claimed: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 2 })
  })

  it('replaces the account default instead of adding to it', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const id = await createEvent(now + 60 * 60_000)
    await store().setEventReminders(id, [60], (await store().getEvent(id))!.rev)

    // The default 10-minute lead would have fired here; the event says otherwise.
    expect((await sweepCalendarReminders(env, now + 51 * 60_000)).sent).toBe(0)
  })

  it('reaches an account that opted out of the default', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await store().savePreferences({
      ...defaultCalendarPreferences(),
      timeZone: 'UTC',
      eventReminderMinutes: 0,
    })
    const id = await createEvent(now + 20 * 60_000)
    await store().setEventReminders(id, [20], (await store().getEvent(id))!.rev)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1 })
  })

  it('follows a recurring series occurrence', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const id = await createEvent(now + 15 * 60_000, 'FREQ=WEEKLY;BYDAY=MO')
    await store().setEventReminders(id, [15], (await store().getEvent(id))!.rev)

    expect((await sweepCalendarReminders(env, now)).sent).toBe(1)
    const week = now + 7 * 24 * 60 * 60 * 1000
    expect((await sweepCalendarReminders(env, week)).sent).toBe(1)
    expect((await sweepCalendarReminders(env, week)).claimed).toBe(1)
  })

  it('refuses a stale revision, a long list and a nonsense lead', async () => {
    const id = await createEvent(Date.parse('2026-10-26T09:00:00Z'))
    const fresh = (await store().getEvent(id))!

    await expect(store().setEventReminders(id, [10], fresh.rev + 1)).rejects.toMatchObject({ status: 409 })
    await expect(store().setEventReminders(id, [0, 5, 10, 15, 30, 60, 120, 1440, 2880], fresh.rev))
      .rejects.toMatchObject({ status: 400 })
    await expect(store().setEventReminders(id, [-1], fresh.rev)).rejects.toMatchObject({ status: 400 })
    await expect(store().setEventReminders(id, [1.5], fresh.rev)).rejects.toMatchObject({ status: 400 })
    await expect(store().setEventReminders('event-missing', [10], 1)).rejects.toMatchObject({ status: 404 })
  })

  it('bumps the event revision so a concurrent edit cannot be missed', async () => {
    const id = await createEvent(Date.parse('2026-10-26T09:00:00Z'))
    const before = (await store().getEvent(id))!

    const answer = await store().setEventReminders(id, [10], before.rev)

    expect(answer.event.rev).toBe(before.rev + 1)
    expect(answer.reminders).toEqual([10])
    await expect(store().setEventReminders(id, [20], before.rev)).rejects.toMatchObject({ status: 409 })
  })

  it('forgets the reminders when the event goes', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const id = await createEvent(now + 60 * 60_000)
    await store().setEventReminders(id, [60], (await store().getEvent(id))!.rev)
    const kept = (await store().getEvent(id))!

    await store().deleteEvent(id, kept.rev)

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_reminders').get())
      .toEqual({ count: 0 })
  })
})

describe('calendar reminder reliability', () => {
  it('delivers a per-event reminder for an account that never saved preferences', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const store = new CalendarStore(db, USER)
    const id = await createEvent(now)
    await store.setEventReminders(id, [0], (await store.getEvent(id))!.rev)
    sqlite.prepare('DELETE FROM calendar_preferences WHERE user_id = ?').run(USER)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1, claimed: 0, failed: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get(USER))
      .toEqual({ count: 1 })
    expect(await sweepCalendarReminders(env, now)).toMatchObject({ sent: 0, claimed: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get(USER))
      .toEqual({ count: 1 })
  })

  it('retries after a notification write fails without leaving a claim', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await createEvent(now + 10 * 60_000)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(AssistantStore.prototype, 'createNotification')
      .mockRejectedValueOnce(new Error('notification store unavailable'))

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 0, claimed: 0, failed: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_reminder_fires').get()).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 0 })

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1, claimed: 0, failed: 0 })
    expect(await sweepCalendarReminders(env, now)).toMatchObject({ sent: 0, claimed: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
  })

  it('does not let already-claimed reminders consume the delivery budget', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const store = new CalendarStore(db, USER)
    const leads = [0, 1, 2, 3, 4, 5]
    for (let index = 0; index < 9; index += 1) {
      const id = await createEvent(now)
      await store.setEventReminders(id, leads, (await store.getEvent(id))!.rev)
      for (const lead of leads) {
        sqlite.prepare(
          `INSERT INTO calendar_reminder_fires
             (user_id, event_id, occurrence_start_ms, minutes, fired_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(USER, id, now, lead, now)
      }
    }
    const otherStore = new CalendarStore(db, OTHER_USER)
    const otherId = await createEvent(now + 10 * 60_000, undefined, OTHER_USER)
    await otherStore.setEventReminders(otherId, [10], (await otherStore.getEvent(otherId))!.rev)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 55, sent: 1, claimed: 54, failed: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications WHERE user_id = ?').get(OTHER_USER))
      .toEqual({ count: 1 })
  })

  it('keeps overlapping sweeps idempotent when both pass the pre-check', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await createEvent(now + 10 * 60_000)

    const results = await Promise.all([sweepCalendarReminders(env, now), sweepCalendarReminders(env, now)])

    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1)
    expect(results.reduce((total, result) => total + result.claimed, 0)).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_reminder_fires').get()).toEqual({ count: 1 })
  })

  it('logs corrupt preferences and recurrence rules but still delivers the master reminder', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const store = new CalendarStore(db, USER)
    const id = await createEvent(now + 10 * 60_000, 'not a recurrence rule')
    await store.setEventReminders(id, [10], (await store.getEvent(id))!.rev)
    sqlite.prepare('UPDATE calendar_preferences SET preferences_json = ? WHERE user_id = ?').run('{broken', USER)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1, failed: 0 })
    expect(error.mock.calls.some(([message, userId]) =>
      message === '[inkstone] calendar reminder preferences failed:' && userId === USER)).toBe(true)
    expect(error.mock.calls.some(([message, eventId]) =>
      message === '[inkstone] calendar reminder recurrence rule failed:' && eventId === id)).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
  })

  it('isolates a corrupt per-event lead instead of skipping the whole account', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const store = new CalendarStore(db, USER)
    const validId = await createEvent(now + 10 * 60_000)
    const corruptId = await createEvent(now + 10 * 60_000)
    await store.setEventReminders(validId, [10], (await store.getEvent(validId))!.rev)
    sqlite.prepare(
      'INSERT INTO calendar_event_reminders (user_id, event_id, minutes, created_at) VALUES (?, ?, ?, ?)',
    ).run(USER, corruptId, -1, now)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1, failed: 0 })
    expect(error.mock.calls.some(([message, userId, eventId]) =>
      message === '[inkstone] calendar reminder rule failed:' && userId === USER && eventId === corruptId)).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
  })

  it('logs an account whose only per-event rule is corrupt', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    const id = await createEvent(now)
    sqlite.prepare(
      'INSERT INTO calendar_event_reminders (user_id, event_id, minutes, created_at) VALUES (?, ?, ?, ?)',
    ).run(USER, id, -1, now)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 0, sent: 0, failed: 0 })
    expect(error.mock.calls.some(([message, userId, eventId]) =>
      message === '[inkstone] calendar reminder rule failed:' && userId === USER && eventId === id)).toBe(true)
  })

  it('logs email deployment read failures with context and continues in-app delivery', async () => {
    const now = Date.parse('2026-10-26T08:00:00Z')
    await createEvent(now + 10 * 60_000)
    sqlite.exec('DROP TABLE email_deployment_settings')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await sweepCalendarReminders(env, now)).toMatchObject({ due: 1, sent: 1, failed: 0 })
    expect(error.mock.calls.some(([message, detail]) =>
      message === '[inkstone] calendar reminder email deployment read failed:'
      && typeof detail === 'string' && detail.includes('email_deployment_settings'))).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM chat_notifications').get()).toEqual({ count: 1 })
  })
})

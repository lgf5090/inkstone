// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { defaultCalendarPreferences } from '../src/shared/calendar/model'
import { CalendarStore } from '../src/worker/calendar/store'
import { sweepCalendarReminders } from '../src/worker/calendar/reminders'
import { EN_US_CALENDAR_NOTIFY } from '../src/shared/locales/en-US-calendar-notify'
import { ZH_CN_CALENDAR_NOTIFY } from '../src/shared/locales/zh-CN-calendar-notify'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = 'user-alice'
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

async function createEvent(startMs: number, recurrenceRule?: string): Promise<string> {
  const start = Temporal.Instant.fromEpochMilliseconds(startMs).toZonedDateTimeISO('UTC').toString()
  const end = Temporal.Instant.fromEpochMilliseconds(startMs + 60 * 60 * 1000).toZonedDateTimeISO('UTC').toString()
  const event = await new CalendarStore(db, USER).createEvent({
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
    calendarIds: [calendarId],
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

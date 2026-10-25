// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CalendarStore, type CalendarEventWriteInput } from '../src/worker/calendar/store'
import { parseEventInput, parsePreferences } from '../src/worker/calendar/validation'
import type { CalendarDto } from '../src/shared/calendar/model'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

let sqlite: DatabaseSync
let db: D1Database
let store: CalendarStore
let calendar: CalendarDto

function eventInput(overrides: Record<string, unknown> = {}): CalendarEventWriteInput {
  return parseEventInput({
    title: 'Meeting',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarId: calendar.id,
    ...overrides,
  }, { defaultTimeZone: 'UTC' })
}

function day(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`)
}

function count(sql: string, ...params: Array<string | number>): number {
  const row = sqlite.prepare(sql).get(...params) as { count: number }
  return Number(row.count)
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  store = new CalendarStore(db, ALICE)
  const calendars = await store.ensureDefaultCalendar()
  calendar = calendars[0]!
})

describe('the default calendar', () => {
  it('is created once with the expected shape', async () => {
    expect(calendar).toMatchObject({
      name: 'Calendar',
      isDefault: true,
      isVisible: true,
      readOnly: false,
      source: 'local',
      position: 0,
      rev: 1,
    })
    expect(calendar.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(calendar.darkColor).toMatch(/^#[0-9a-f]{6}$/i)
    expect(await store.ensureDefaultCalendar()).toHaveLength(1)
  })

  it('hands the default flag over when another create asks for it', async () => {
    const work = await store.createCalendar({ name: 'Work', isDefault: true })
    expect(work.isDefault).toBe(true)
    const calendars = await store.listCalendars()
    expect(calendars.find((entry) => entry.id === calendar.id)?.isDefault).toBe(false)
    expect(calendars.find((entry) => entry.id === work.id)?.isDefault).toBe(true)
  })

  it('is reassigned when the default calendar is deleted', async () => {
    const work = await store.createCalendar({ name: 'Work', isDefault: true })
    await store.deleteCalendar(work.id, { mode: 'delete' })
    const calendars = await store.listCalendars()
    expect(calendars).toHaveLength(1)
    expect(calendars[0]?.id).toBe(calendar.id)
    expect(calendars[0]?.isDefault).toBe(true)
  })
})

describe('calendar CRUD', () => {
  it('creates, reads, updates and refuses a stale revision', async () => {
    const work = await store.createCalendar({ id: 'cal-work', name: 'Work', color: '#112233', darkColor: '#445566' })
    expect(work.id).toBe('cal-work')
    expect(work.color).toBe('#112233')

    const renamed = await store.updateCalendar(work.id, { rev: work.rev, name: 'Job' })
    expect(renamed.name).toBe('Job')
    expect(renamed.rev).toBe(work.rev + 1)

    await expect(store.updateCalendar(work.id, { rev: work.rev, name: 'Stale' }))
      .rejects.toMatchObject({ status: 409 })
    await expect(store.updateCalendar('missing', { rev: 1, name: 'Nope' }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('refuses to delete the last calendar', async () => {
    await expect(store.deleteCalendar(calendar.id, { mode: 'delete' }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('checks the revision a delete names', async () => {
    const work = await store.createCalendar({ name: 'Work' })
    await expect(store.deleteCalendar(work.id, { mode: 'delete', rev: work.rev + 1 }))
      .rejects.toMatchObject({ status: 409 })
    await store.deleteCalendar(work.id, { mode: 'delete', rev: work.rev })
    expect(await store.listCalendars()).toHaveLength(1)
  })

  it('reorders every calendar exactly once', async () => {
    const work = await store.createCalendar({ name: 'Work' })
    const home = await store.createCalendar({ name: 'Home' })
    await store.reorderCalendars([home.id, calendar.id, work.id])
    const ordered = await store.listCalendars()
    expect(ordered.map((entry) => entry.id)).toEqual([home.id, calendar.id, work.id])
    expect(ordered.map((entry) => entry.position)).toEqual([0, 1, 2])
    await expect(store.reorderCalendars([calendar.id])).rejects.toMatchObject({ status: 400 })
  })
})

describe('calendar groups', () => {
  it('creates, renames and refuses a duplicate without regard to case', async () => {
    const group = await store.createGroup({ name: 'Work' })
    expect(group.name).toBe('Work')
    await expect(store.createGroup({ name: 'work' })).rejects.toMatchObject({ status: 409 })

    const other = await store.createGroup({ name: 'Home' })
    await expect(store.renameGroup(other.id, 'WORK')).rejects.toMatchObject({ status: 409 })
    const renamed = await store.renameGroup(other.id, 'Personal')
    expect(renamed.name).toBe('Personal')
  })

  it('moves calendars to ungrouped when the group is deleted', async () => {
    const group = await store.createGroup({ name: 'Work' })
    const work = await store.createCalendar({ name: 'Work', groupId: group.id })
    expect(work.groupId).toBe(group.id)
    await store.deleteGroup(group.id)
    const calendars = await store.listCalendars()
    expect(calendars.find((entry) => entry.id === work.id)?.groupId).toBeNull()
    expect(await store.listGroups()).toHaveLength(0)
  })

  it('reorders groups', async () => {
    const work = await store.createGroup({ name: 'Work' })
    const home = await store.createGroup({ name: 'Home' })
    await store.reorderGroups([home.id, work.id])
    expect((await store.listGroups()).map((entry) => entry.id)).toEqual([home.id, work.id])
  })
})

describe('event round trips', () => {
  it('preserves every field the DTO carries', async () => {
    const created = await store.createEvent(eventInput({
      title: 'Design review',
      description: 'Bring the deck',
      icon: true,
      conference: { joinUrl: 'https://meet.google.com/abc-defg-hij', provider: 'google-meet' },
      meta: { location: 'Room 3', custom: { value: 1 } },
      task: {
        completed: true,
        completedAt: { value: '2026-10-26T08:00:00Z[UTC]', type: 'zoned', timeZone: 'UTC' },
        priority: 'high',
      },
      recurrenceRule: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
    }))

    expect(created.title).toBe('Design review')
    expect(created.description).toBe('Bring the deck')
    expect(created.icon).toBe(true)
    expect(created.conference).toEqual({ joinUrl: 'https://meet.google.com/abc-defg-hij', provider: 'google-meet' })
    expect(created.meta).toEqual({ location: 'Room 3', custom: { value: 1 }, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' })
    expect(created.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO')
    expect(created.task).toEqual({
      completed: true,
      completedAt: { value: '2026-10-26T08:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
      priority: 'high',
    })
    expect(created.calendarId).toBe(calendar.id)
    expect(created.calendarIds).toEqual([calendar.id])
    expect(created.rev).toBe(1)
    expect(created.source).toBe('local')
    expect(await store.getEvent(created.id)).toEqual(created)
  })

  it('accepts an all-day event only with date values', async () => {
    const allDay = await store.createEvent(eventInput({
      title: 'Holiday',
      start: { value: '2026-10-26', type: 'date' },
      end: { value: '2026-10-27', type: 'date' },
    }))
    expect(allDay.allDay).toBe(true)
    expect(allDay.start).toEqual({ value: '2026-10-26', type: 'date' })

    expect(() => eventInput({
      start: { value: '2026-10-26', type: 'date' },
      end: { value: '2026-10-27', type: 'date' },
      allDay: false,
    })).toThrow()
  })

  it('keeps multi-calendar membership ordered by position', async () => {
    const second = await store.createCalendar({ id: 'cal-second', name: 'Second' })
    const created = await store.createEvent(eventInput({ calendarIds: [second.id, calendar.id] }))
    expect(created.calendarIds).toEqual([second.id, calendar.id])
    expect(created.calendarId).toBe(second.id)
    expect(count(
      `SELECT COUNT(*) AS count FROM calendar_event_calendars WHERE user_id = ? AND event_id = ?`,
      ALICE,
      created.id,
    )).toBe(2)
  })

  it('refuses a calendar this account does not own', async () => {
    const bobStore = new CalendarStore(db, BOB)
    await bobStore.ensureDefaultCalendar()
    await expect(bobStore.createEvent(parseEventInput({
      title: 'Stolen',
      start: { value: '2026-10-26T09:00:00', type: 'datetime' },
      end: { value: '2026-10-26T10:00:00', type: 'datetime' },
      calendarId: calendar.id,
    }, { defaultTimeZone: 'UTC' }))).rejects.toMatchObject({ status: 404 })
  })

  it('accepts remote ids and rejects generated occurrence ids', async () => {
    const remote = await store.createEvent(eventInput({
      id: 'caldav:event-1@example.com',
      title: 'Remote',
      source: 'caldav',
      externalId: 'event-1@example.com',
    }))
    expect(remote.id).toBe('caldav:event-1@example.com')
    expect(remote.source).toBe('caldav')
    expect(remote.externalId).toBe('event-1@example.com')

    expect(() => eventInput({ id: 'master::repeat-1' })).toThrow()
  })
})

describe('event ranges and revisions', () => {
  it('returns overlapping events and every recurrence master', async () => {
    const inside = await store.createEvent(eventInput({ title: 'Inside' }))
    await store.createEvent(eventInput({
      title: 'Outside',
      start: { value: '2026-12-01T09:00:00', type: 'datetime' },
      end: { value: '2026-12-01T10:00:00', type: 'datetime' },
    }))
    const master = await store.createEvent(eventInput({
      title: 'Series',
      start: { value: '2020-01-06T09:00:00', type: 'datetime' },
      end: { value: '2020-01-06T10:00:00', type: 'datetime' },
      recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
    }))

    const events = await store.listEvents(day('2026-10-01'), day('2026-11-01'))
    expect(events.map((event) => event.id).sort()).toEqual([inside.id, master.id].sort())
  })

  it('filters the range by calendar membership', async () => {
    const second = await store.createCalendar({ name: 'Second' })
    const first = await store.createEvent(eventInput({ title: 'First only' }))
    const both = await store.createEvent(eventInput({ title: 'Both', calendarIds: [calendar.id, second.id] }))
    const events = await store.listEvents(day('2026-10-01'), day('2026-11-01'), [second.id])
    expect(events.map((event) => event.id)).toEqual([both.id])
    expect(events[0]?.calendarId).toBe(calendar.id)
    expect(first.id).not.toBe(both.id)
  })

  it('bumps rev on update and refuses a stale revision', async () => {
    const created = await store.createEvent(eventInput())
    const updated = await store.updateEvent(created.id, { rev: created.rev, title: 'Renamed' })
    expect(updated.title).toBe('Renamed')
    expect(updated.rev).toBe(created.rev + 1)
    await expect(store.updateEvent(created.id, { rev: created.rev, title: 'Stale' }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('replaces membership when the patch moves the event', async () => {
    const second = await store.createCalendar({ name: 'Second' })
    const created = await store.createEvent(eventInput())
    const moved = await store.updateEvent(created.id, { rev: created.rev, calendarIds: [second.id] })
    expect(moved.calendarId).toBe(second.id)
    expect(moved.calendarIds).toEqual([second.id])
    expect(count(
      `SELECT COUNT(*) AS count FROM calendar_event_calendars WHERE user_id = ? AND event_id = ?`,
      ALICE,
      created.id,
    )).toBe(1)
  })

  it('hard-deletes the event and its memberships, checking rev', async () => {
    const created = await store.createEvent(eventInput())
    await expect(store.deleteEvent(created.id, created.rev + 1)).rejects.toMatchObject({ status: 409 })
    expect(await store.getEvent(created.id)).not.toBeNull()
    await store.deleteEvent(created.id, created.rev)
    expect(await store.getEvent(created.id)).toBeNull()
    expect(count(
      `SELECT COUNT(*) AS count FROM calendar_event_calendars WHERE user_id = ? AND event_id = ?`,
      ALICE,
      created.id,
    )).toBe(0)
  })
})

describe('batch writes', () => {
  it('creates 200 events and rejects a larger batch', async () => {
    const inputs = Array.from({ length: 200 }, (_value, index) => eventInput({
      id: `batch-${index}`,
      title: `Batch ${index}`,
    }))
    const created = await store.createEvents(inputs, 'create')
    expect(created).toHaveLength(200)
    expect(count(`SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?`, ALICE)).toBe(200)
    expect(count(`SELECT COUNT(*) AS count FROM calendar_event_calendars WHERE user_id = ?`, ALICE)).toBe(200)

    const tooMany = Array.from({ length: 201 }, (_value, index) => eventInput({ title: `Over ${index}` }))
    await expect(store.createEvents(tooMany, 'create')).rejects.toMatchObject({ status: 400 })
  })

  it('upserts by id and by external id', async () => {
    const created = await store.createEvent(eventInput({ id: 'remote-1', externalId: 'remote-1', source: 'caldav' }))
    const byId = await store.createEvents([eventInput({ id: created.id, title: 'By id' })], 'upsert')
    expect(byId[0]?.title).toBe('By id')
    expect(byId[0]?.rev).toBe(created.rev + 1)

    const byExternal = await store.createEvents([eventInput({
      title: 'By external',
      externalId: 'remote-1',
      source: 'caldav',
    })], 'upsert')
    expect(byExternal[0]?.id).toBe(created.id)
    expect(byExternal[0]?.title).toBe('By external')
    expect(byExternal[0]?.rev).toBe(created.rev + 2)
  })
})

describe('calendar merge and delete semantics', () => {
  it('moves memberships on merge and removes the source', async () => {
    const second = await store.createCalendar({ name: 'Second' })
    const onlyFirst = await store.createEvent(eventInput({ title: 'Only first' }))
    const both = await store.createEvent(eventInput({ title: 'Both', calendarIds: [calendar.id, second.id] }))

    await store.mergeCalendar(calendar.id, second.id)
    expect(await store.listCalendars()).toHaveLength(1)
    const first = await store.getEvent(onlyFirst.id)
    const shared = await store.getEvent(both.id)
    expect(first?.calendarIds).toEqual([second.id])
    expect(shared?.calendarIds).toEqual([second.id])
  })

  it('deletes only the events the removed calendar alone held', async () => {
    const second = await store.createCalendar({ name: 'Second' })
    const onlyFirst = await store.createEvent(eventInput({ title: 'Only first' }))
    const both = await store.createEvent(eventInput({ title: 'Both', calendarIds: [calendar.id, second.id] }))

    await store.deleteCalendar(calendar.id, { mode: 'delete' })
    expect(await store.getEvent(onlyFirst.id)).toBeNull()
    const shared = await store.getEvent(both.id)
    expect(shared?.calendarIds).toEqual([second.id])
    expect((await store.listCalendars())[0]?.isDefault).toBe(true)
  })
})

describe('search', () => {
  it('matches title and description and reports truncation', async () => {
    await store.createEvent(eventInput({ title: 'Design review', description: 'deck and notes' }))
    await store.createEvent(eventInput({ title: 'Lunch', description: 'design chat' }))
    const answer = await store.searchEvents('design', 20)
    expect(answer.results.map((entry) => entry.event.title).sort()).toEqual(['Design review', 'Lunch'])
    expect(answer.results[0]?.calendarName).toBe('Calendar')
    expect(answer.truncated).toBe(false)

    const limited = await store.searchEvents('design', 1)
    expect(limited.results).toHaveLength(1)
    expect(limited.truncated).toBe(true)
  })

  it('treats percent and underscore as literals', async () => {
    await store.createEvent(eventInput({ title: '100% done' }))
    await store.createEvent(eventInput({ title: '100x done' }))
    await store.createEvent(eventInput({ title: 'under_score' }))
    await store.createEvent(eventInput({ title: 'underXscore' }))

    expect((await store.searchEvents('100%', 50)).results.map((entry) => entry.event.title)).toEqual(['100% done'])
    expect((await store.searchEvents('under_', 50)).results.map((entry) => entry.event.title)).toEqual(['under_score'])
  })
})

describe('account isolation', () => {
  it('never lets another account read, change or delete an event', async () => {
    const created = await store.createEvent(eventInput({ title: 'Private' }))
    const bobStore = new CalendarStore(db, BOB)
    await bobStore.ensureDefaultCalendar()

    expect(await bobStore.getEvent(created.id)).toBeNull()
    expect(await bobStore.listEvents(day('2026-10-01'), day('2026-11-01'))).toEqual([])
    await expect(bobStore.updateEvent(created.id, { rev: created.rev, title: 'Stolen' }))
      .rejects.toMatchObject({ status: 404 })
    await expect(bobStore.deleteEvent(created.id, created.rev)).rejects.toMatchObject({ status: 404 })
  })
})

describe('preferences', () => {
  it('answers defaults before anything was saved and reads back a strict full shape', async () => {
    const defaults = await store.preferences()
    expect(defaults.defaultView).toBe('week')
    expect(defaults.weekStart).toBe(1)

    const saved = await store.savePreferences(parsePreferences({ weekStart: 0, timeZone: 'UTC', defaultView: 'month' }))
    expect(saved.weekStart).toBe(0)
    expect(saved.defaultView).toBe('month')
    expect((await store.preferences()).timeZone).toBe('UTC')

    expect(() => parsePreferences({ weekStart: 7 })).toThrow()
    expect(() => parsePreferences({ notASetting: true })).toThrow()
  })
})

describe('validation at the boundary', () => {
  it('refuses secret-looking meta and non-https conference links', () => {
    expect(() => eventInput({ meta: { refreshToken: 'x' } })).toThrow()
    expect(() => eventInput({ conference: { joinUrl: 'http://meet.example.com/x' } })).toThrow()
    expect(() => eventInput({ conference: { joinUrl: 'javascript:alert(1)' } })).toThrow()
  })

  it('refuses a recurrence without a supported frequency', () => {
    expect(() => eventInput({ recurrenceRule: 'FREQ=HOURLY' })).toThrow()
  })
})

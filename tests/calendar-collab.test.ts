// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import type { ExecutionContext } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_CALENDARS, MAX_EVENTS_PER_QUERY, sharedCalendarId, type CalendarDto, type CalendarEventDto, type CalendarMetaDto } from '../src/shared/calendar/model'
import { MAX_RECURRENCE_OCCURRENCES } from '../src/worker/calendar/ics'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { clearRateLimit } from '../src/worker/lib/rate-limit'
import { createContact } from '../src/worker/calendar/contacts'
import { MAX_TEMPLATES, insertTemplateRow } from '../src/worker/calendar/templates'
import { MAX_SCHEDULING_LINKS } from '../src/worker/calendar/scheduling'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarMemberRoutes } from '../src/worker/routes/calendar-members'
import { calendarContactRoutes } from '../src/worker/routes/calendar-contacts'
import { calendarTemplateRoutes } from '../src/worker/routes/calendar-templates'
import { calendarResourceRoutes } from '../src/worker/routes/calendar-resources'
import { calendarBookingRoutes, calendarSchedulingRoutes } from '../src/worker/routes/calendar-scheduling'
import type { AppBindings } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const CAROL = 'user-carol'

let sqlite: DatabaseSync
let db: D1Database
let user: string

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
}

const app = new Hono<AppBindings>()
app.onError((err, c) => errorResponse(c, err))
app.use('*', async (c, next) => {
  if (user) c.set('userId', user)
  await next()
})
app.route('/api/calendar', calendarMemberRoutes)
app.route('/api/calendar', calendarContactRoutes)
app.route('/api/calendar', calendarTemplateRoutes)
app.route('/api/calendar', calendarResourceRoutes)
app.route('/api/calendar', calendarSchedulingRoutes)
app.route('/api/calendar', calendarRoutes)
app.route('/api/public/calendar', calendarBookingRoutes)

function env(): AppBindings['Bindings'] {
  return { DB: db } as unknown as AppBindings['Bindings']
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env(), ctx)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

function insertUser(id: string, username: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
     VALUES (?, ?, 'hash', ?, ?, '', 'member', '{}', 1, 1)`,
  ).run(id, username, username, username)
}

async function defaultCalendar(): Promise<CalendarDto> {
  return (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))).calendars[0]!
}

function eventBody(calendarId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Review',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarId,
    ...overrides,
  }
}

beforeEach(() => {
  clearRateLimit()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  sqlite.exec('DELETE FROM users')
  insertUser(ALICE, 'alice')
  insertUser(BOB, 'bob')
  insertUser(CAROL, 'carol')
  user = ALICE
})

async function invite(calendarId: string, username: string, role: 'reader' | 'writer'): Promise<void> {
  await json(await call('POST', `/api/calendar/calendars/${calendarId}/members`, { username, role }))
}

async function accept(ownerId: string, calendarId: string): Promise<void> {
  const response = await call('POST', `/api/calendar/invites/${ownerId}/${calendarId}/response`, { status: 'accepted' })
  expect(response.status).toBe(204)
}

describe('account sharing', () => {
  it('uses one non-enumerating invitation response and rate-limits each target', async () => {
    const calendar = await defaultCalendar()
    const missing = await call('POST', `/api/calendar/calendars/${calendar.id}/members`, { username: 'missing-user', role: 'reader' })
    expect(missing.status).toBe(202)
    expect(await missing.json()).toEqual({ invited: true })
    const existing = await call('POST', `/api/calendar/calendars/${calendar.id}/members`, { username: 'bob', role: 'reader' })
    expect(existing.status).toBe(202)
    expect(await existing.json()).toEqual({ invited: true })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_members WHERE member_user_id = ?').get(BOB)).toEqual({ count: 1 })
    const pending = await json<{ members: Array<{ name: string; status: string }> }>(await call('GET', `/api/calendar/calendars/${calendar.id}/members`))
    expect(pending.members.find(member => member.status === 'pending')?.name).toBe('')
    expect((await call('POST', `/api/calendar/calendars/${calendar.id}/members`, { username: 'bob', role: 'reader' })).status).toBe(202)
    expect((await call('POST', `/api/calendar/calendars/${calendar.id}/members`, { username: 'bob', role: 'reader' })).status).toBe(202)
    expect((await call('POST', `/api/calendar/calendars/${calendar.id}/members`, { username: 'bob', role: 'reader' })).status).toBe(429)
  })

  it('keeps accepted access when the owner re-invites the member', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'reader')
    user = BOB
    await accept(ALICE, calendar.id)
    user = ALICE
    await invite(calendar.id, 'bob', 'writer')
    user = BOB
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(meta.invites?.some(entry => entry.calendarId === calendar.id)).toBe(false)
    expect(meta.calendars.find(entry => entry.id.startsWith('shared:'))?.sharedRole).toBe('writer')
  })

  it('rejects malformed member and invite ids before querying', async () => {
    expect((await call('GET', '/api/calendar/calendars/bad!/members')).status).toBe(400)
    expect((await call('POST', '/api/calendar/invites/bad!/calendar/response', { status: 'accepted' })).status).toBe(400)
    expect((await call('DELETE', '/api/calendar/calendars/calendar/members/bad!')).status).toBe(400)
  })

  it('invites, accepts, and lets a writer create and edit an event in the shared calendar', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'writer')
    await invite(calendar.id, 'carol', 'reader')

    user = BOB
    const bobMeta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(bobMeta.invites?.map(entry => entry.calendarId)).toContain(calendar.id)
    await accept(ALICE, calendar.id)

    const after = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    const shared = after.calendars.find(entry => entry.id.startsWith('shared:'))!
    expect(shared.readOnly).toBe(false)
    expect(shared.sharedRole).toBe('writer')

    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', {
      ...eventBody(shared.id),
      title: 'Written by Bob',
    }))
    expect(created.event.id.startsWith('shared:')).toBe(true)
    expect(created.event.calendarId).toBe(shared.id)

    const updated = await json<{ event: CalendarEventDto }>(await call('PATCH', `/api/calendar/events/${encodeURIComponent(created.event.id)}`, {
      rev: created.event.rev,
      title: 'Bob edited',
    }))
    expect(updated.event.title).toBe('Bob edited')

    user = ALICE
    const ownerEvent = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id.split(':').at(-1)}`))
    expect(ownerEvent.event.title).toBe('Bob edited')
  })

  it('shares extras reads and routes snooze and delete through the owner event', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'writer')
    await invite(calendar.id, 'carol', 'reader')
    user = CAROL
    expect((await call('GET', `/api/calendar/events/${sharedCalendarId(ALICE, 'missing')}/extras`)).status).toBe(404)
    user = BOB
    await accept(ALICE, calendar.id)
    const sharedCalendar = (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))).calendars.find(entry => entry.id.startsWith('shared:'))!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', {
      ...eventBody(sharedCalendar.id),
      title: 'Shared extras',
    }))
    const id = created.event.id
    const rawId = id.split(':').at(-1)!
    const reminded = await json<{ event: CalendarEventDto }>(await call('PUT', `/api/calendar/events/${id}/reminders`, {
      minutes: [15], rev: created.event.rev,
    }))
    const attended = await json<{ event: CalendarEventDto }>(await call('PUT', `/api/calendar/events/${id}/attendees`, {
      attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }], rev: reminded.event.rev,
    }))
    expect((await call('POST', `/api/calendar/events/${id}/snooze`, { minutes: 5 })).status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM calendar_reminder_snoozes WHERE user_id = ? AND event_id = ?')
      .get(ALICE, rawId)).toEqual({ n: 1 })

    user = CAROL
    await accept(ALICE, calendar.id)
    expect((await call('GET', `/api/calendar/events/${id}/reminders`)).status).toBe(200)
    expect(await (await call('GET', `/api/calendar/events/${id}/reminders`)).json()).toEqual({ minutes: [15] })
    expect(await (await call('GET', `/api/calendar/events/${id}/attendees`)).json()).toEqual({
      attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }],
    })
    const extras = await json<{ reminders: number[]; attendees: unknown[] }>(await call('GET', `/api/calendar/events/${id}/extras`))
    expect(extras.reminders).toEqual([15])
    expect(extras.attendees).toHaveLength(1)
    expect((await call('POST', `/api/calendar/events/${id}/snooze`, { minutes: 5 })).status).toBe(403)

    user = BOB
    expect((await call('DELETE', `/api/calendar/events/${id}?rev=${attended.event.rev}`)).status).toBe(204)
    user = ALICE
    expect((await call('GET', `/api/calendar/events/${rawId}`)).status).toBe(404)
  })

  it('routes a shared series edit through the owner store and answers the shared id', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'writer')
    user = BOB
    await accept(ALICE, calendar.id)
    const shared = (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta')))
      .calendars.find(entry => entry.id.startsWith('shared:'))!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(shared.id, {
      title: 'Shared series',
      recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })))

    const answer = await call('POST', `/api/calendar/events/${encodeURIComponent(created.event.id)}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: created.event.start,
      occurrenceEnd: created.event.end,
      scope: 'all',
      action: 'update',
      patch: { title: 'Shared series edited' },
    })
    expect(answer.status).toBe(200)
    const result = await answer.json() as { masterId: string | null }
    // The response speaks the guest's id space, because that is the id their next write will use.
    expect(result.masterId).toBe(created.event.id)

    user = ALICE
    const ownerEvent = await json<{ event: CalendarEventDto }>(
      await call('GET', `/api/calendar/events/${created.event.id.split(':').at(-1)}`),
    )
    expect(ownerEvent.event.title).toBe('Shared series edited')
  })

  it('refuses a reader editing a shared series', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Owner series',
      recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })))
    await invite(calendar.id, 'carol', 'reader')
    user = CAROL
    await accept(ALICE, calendar.id)
    const sharedId = `shared:${ALICE}:${created.event.id}`
    const answer = await call('POST', `/api/calendar/events/${encodeURIComponent(sharedId)}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: created.event.start,
      occurrenceEnd: created.event.end,
      scope: 'all',
      action: 'update',
      patch: { title: 'Should not land' },
    })
    expect(answer.status).toBe(403)
  })

  it('refuses a writer moving a shared event into an owner-only calendar', async () => {
    const calendar = await defaultCalendar()
    const privateCal = await json<{ calendar: CalendarDto }>(await call('POST', '/api/calendar/calendars', { name: 'Private' }))
    await invite(calendar.id, 'bob', 'writer')
    user = BOB
    await accept(ALICE, calendar.id)
    const shared = (await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta')))
      .calendars.find(entry => entry.id.startsWith('shared:'))!
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(shared.id)))
    const moved = await call('PATCH', `/api/calendar/events/${encodeURIComponent(created.event.id)}`, {
      rev: created.event.rev,
      calendarIds: [privateCal.calendar.id],
    })
    expect(moved.status).toBe(403)
  })

  it('refuses a reader write and an unrelated account', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'carol', 'reader')
    user = CAROL
    await accept(ALICE, calendar.id)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    const shared = meta.calendars.find(entry => entry.id.startsWith('shared:'))!
    expect(shared.readOnly).toBe(true)
    expect((await call('POST', '/api/calendar/events', eventBody(shared.id))).status).toBe(403)

    user = BOB
    expect((await call('POST', '/api/calendar/events', eventBody(shared.id))).status).toBe(403)
  })

  it('lets the guest leave and keeps declined rows out of the sidebar', async () => {
    const calendar = await defaultCalendar()
    await invite(calendar.id, 'bob', 'reader')
    user = BOB
    await accept(ALICE, calendar.id)
    expect((await call('DELETE', `/api/calendar/invites/${ALICE}/${calendar.id}`)).status).toBe(204)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(meta.calendars.some(entry => entry.id.startsWith('shared:'))).toBe(false)
  })
})

async function range(from: string, to: string): Promise<{ events: CalendarEventDto[]; occurrences: CalendarEventDto[] }> {
  return json(await call('GET', `/api/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&occurrences=1`))
}

describe('recurrence exceptions', () => {
  it('turns one occurrence into an override and hides the master copy with EXDATE', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Standup',
      recurrenceRule: 'FREQ=DAILY;COUNT=4',
    })))
    const week = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    expect(week.occurrences).toHaveLength(3)
    const target = week.occurrences[0]!

    const answer = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'this',
      action: 'update',
      patch: { title: 'Standup with Bob' },
    })
    expect(answer.status).toBe(200)

    const after = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    expect(after.occurrences).toHaveLength(2)
    const override = after.events.find(event => event.recurrenceParentId === created.event.id)
    expect(override?.title).toBe('Standup with Bob')

    const master = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect(Array.isArray(master.event.meta.exdates)).toBe(true)
  })

  it('deletes overrides together with their master', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Cascade series', recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })))
    const week = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    const target = week.occurrences[0]!
    expect((await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: target.start, occurrenceEnd: target.end, scope: 'this', action: 'update', patch: { title: 'Override' },
    })).status).toBe(200)
    const master = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect((await call('DELETE', `/api/calendar/events/${created.event.id}?rev=${master.event.rev}`)).status).toBe(204)
    const after = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    expect(after.events).toHaveLength(0)
    expect(after.occurrences).toHaveLength(0)
  })

  it('splits a series for this-and-following and truncates the old rule', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Weekly',
      recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
    })))
    const month = await range('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z')
    const target = month.occurrences[1]!
    const split = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'following',
      action: 'update',
      patch: { title: 'New series' },
    })
    expect(split.status).toBe(200)
    const after = await range('2026-10-01T00:00:00Z', '2026-11-30T00:00:00Z')
    const masters = after.events.filter(event => event.recurrenceRule)
    expect(masters).toHaveLength(2)
    expect(masters.some(event => event.title === 'New series')).toBe(true)
    expect(masters.find(event => event.id === created.event.id)?.recurrenceRule).toContain('COUNT=2')
  })

  it('carries future exdates into a following series without reviving cancelled occurrences', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Daily', recurrenceRule: 'FREQ=DAILY;COUNT=5',
    })))
    const first = await range('2026-10-26T00:00:00Z', '2026-10-31T00:00:00Z')
    const cancelled = first.occurrences.find(event => event.start.value.startsWith('2026-10-28'))!
    expect((await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: cancelled.start, occurrenceEnd: cancelled.end, scope: 'this', action: 'cancel',
    })).status).toBe(200)
    const target = first.occurrences.find(event => event.start.value.startsWith('2026-10-27'))!
    const currentMaster = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect((await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: currentMaster.event.rev,
      occurrenceStart: target.start, occurrenceEnd: target.end, scope: 'following', action: 'update', patch: { title: 'Following' },
    })).status).toBe(200)
    const after = await range('2026-10-26T00:00:00Z', '2026-11-01T00:00:00Z')
    const dates = [...after.events, ...after.occurrences].map(event => event.start.value.slice(0, 10))
    expect(dates).not.toContain('2026-10-28')
    expect(dates).toEqual(expect.arrayContaining(['2026-10-26', '2026-10-27', '2026-10-29', '2026-10-30']))
  })

  it('shifts a zoned master when the reader edits the whole series', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Zoned series',
      start: { value: '2026-11-10T09:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      end: { value: '2026-11-10T10:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      recurrenceRule: 'FREQ=DAILY;COUNT=3',
    })))
    const response = await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: created.event.start,
      occurrenceEnd: created.event.end,
      scope: 'all',
      action: 'update',
      patch: {
        title: 'Zoned series moved',
        start: { value: '2026-11-10T10:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
        end: { value: '2026-11-10T11:00:00+08:00[Asia/Shanghai]', type: 'zoned', timeZone: 'Asia/Shanghai' },
      },
    })
    expect(response.status).toBe(200)
    const master = await json<{ event: CalendarEventDto }>(await call('GET', `/api/calendar/events/${created.event.id}`))
    expect(master.event.title).toBe('Zoned series moved')
    expect(master.event.start.value).toContain('10:00:00')
  })

  it('cancels this and following without leaving orphan overrides', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Daily',
      recurrenceRule: 'FREQ=DAILY;COUNT=10',
    })))
    const week = await range('2026-10-26T00:00:00Z', '2026-10-30T00:00:00Z')
    const target = week.occurrences[1]!
    expect((await call('POST', `/api/calendar/events/${created.event.id}/recurrence`, {
      rev: created.event.rev,
      occurrenceStart: target.start,
      occurrenceEnd: target.end,
      scope: 'following',
      action: 'cancel',
    })).status).toBe(200)
    const after = await range('2026-10-28T00:00:00Z', '2026-11-10T00:00:00Z')
    expect(after.occurrences).toHaveLength(0)
  })
})

const SLOT_MS = 15 * 60_000
const RECURRING_OCCURRENCES_PER_MASTER = 13

async function bookingLink(calendarId: string): Promise<{ id: string; slug: string; calendarId: string }> {
  const answer = await json<{ link: { id: string; slug: string; calendarId: string } }>(
    await call('POST', '/api/calendar/scheduling-links', {
      calendarId,
      title: 'Intro call',
      durationMinutes: 30,
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
    }),
  )
  return answer.link
}

function alignedStart(offsetMs = 3 * 86_400_000): number {
  return Math.ceil((Date.now() + offsetMs) / SLOT_MS) * SLOT_MS
}

function timedEvent(calendarId: string, startMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return eventBody(calendarId, {
    start: { value: new Date(startMs).toISOString().replace('Z', '[UTC]'), type: 'zoned' },
    end: { value: new Date(startMs + 60 * 60_000).toISOString().replace('Z', '[UTC]'), type: 'zoned' },
    ...overrides,
  })
}

describe('required write revisions', () => {
  it('requires revisions for contacts, templates and calendar removal', async () => {
    const contact = await json<{ contact: { id: string; rev: number } }>(await call('POST', '/api/calendar/contacts', {
      name: 'Contact', email: 'revision@example.com', birthday: null,
    }))
    expect((await call('PATCH', `/api/calendar/contacts/${contact.contact.id}`, { name: 'No revision' })).status).toBe(400)
    expect((await call('PATCH', `/api/calendar/contacts/${contact.contact.id}`, { name: 'Stale', rev: contact.contact.rev + 1 })).status).toBe(409)

    const template = await json<{ template: { id: string } }>(await call('POST', '/api/calendar/templates', {
      name: 'Template', title: 'Review', description: '', kind: 'event', allDay: false, durationMinutes: 30,
    }))
    expect((await call('PATCH', `/api/calendar/templates/${template.template.id}`, { title: 'No revision' })).status).toBe(400)

    const calendar = await defaultCalendar()
    expect((await call('DELETE', `/api/calendar/calendars/${calendar.id}?mode=delete`)).status).toBe(400)
    expect((await call('DELETE', `/api/calendar/calendars/${calendar.id}?mode=merge&targetId=${calendar.id}`)).status).toBe(400)
  })
})

describe('holiday imports and birthday sync', () => {
  it('reuses a holiday calendar and allows two holidays on the same date', async () => {
    const body = {
      calendarName: 'Company holidays',
      holidays: [
        { date: '2026-10-01', title: 'National day' },
        { date: '2026-10-01', title: 'Company day' },
      ],
    }
    const first = await json<{ calendarId: string; imported: number }>(await call('POST', '/api/calendar/holidays', body))
    const second = await json<{ calendarId: string; imported: number }>(await call('POST', '/api/calendar/holidays', body))
    expect(first).toMatchObject({ imported: 2 })
    expect(second).toEqual(first)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(ALICE)).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(ALICE)).toEqual({ count: 2 })
    expect(sqlite.prepare('SELECT COUNT(DISTINCT id) AS count FROM calendar_events WHERE user_id = ?').get(ALICE)).toEqual({ count: 2 })
  })

  it('removes a newly created holiday calendar when the event batch fails', async () => {
    sqlite.exec(`CREATE TRIGGER fail_holiday_insert
      BEFORE INSERT ON calendar_events
      WHEN NEW.title = 'National day'
      BEGIN SELECT RAISE(ABORT, 'forced holiday failure'); END`)
    const response = await call('POST', '/api/calendar/holidays', {
      calendarName: 'Failed holidays',
      holidays: [{ date: '2026-10-01', title: 'National day' }],
    })
    expect(response.status).toBe(500)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(ALICE)).toEqual({ count: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(ALICE)).toEqual({ count: 0 })
  })

  it('rejects an all-invalid holiday import without creating a calendar', async () => {
    expect((await call('POST', '/api/calendar/holidays', {
      calendarName: 'Invalid holidays', holidays: [{ date: 'not-a-date', title: 'Invalid' }],
    })).status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(ALICE)).toEqual({ count: 0 })
  })

  it('syncs more than two hundred birthdays in batches', async () => {
    const insert = sqlite.prepare(
      'INSERT INTO calendar_contacts (user_id, id, name, email, birthday, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, 1, 1, 1)',
    )
    for (let index = 0; index < 201; index += 1) {
      insert.run(ALICE, `birthday-contact-${index}`, `Person ${index}`, `person-${index}@example.com`, '1990-01-02')
    }
    const result = await json<{ imported: number }>(await call('POST', '/api/calendar/birthdays/sync', { calendarName: 'Birthdays' }))
    expect(result.imported).toBe(201)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(ALICE)).toEqual({ count: 201 })
  })
})

describe('entity write quotas', () => {
  it('refuses contacts, templates, booking links and resources at their limits', async () => {
    const contactInsert = sqlite.prepare(
      'INSERT INTO calendar_contacts (user_id, id, name, email, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, 1)',
    )
    for (let index = 0; index < 5000; index += 1) {
      contactInsert.run(ALICE, `quota-contact-${index}`, `Contact ${index}`, `contact-${index}@example.com`, 1, 1)
    }
    await expect(createContact(db, ALICE, { name: 'Overflow', email: 'overflow@example.com' }))
      .rejects.toMatchObject({ status: 409 })

    const templateInsert = sqlite.prepare(
      `INSERT INTO calendar_event_templates
         (user_id, id, name, title, description, kind, all_day, duration_minutes, color, meta_json, created_at, updated_at, rev)
       VALUES (?, ?, ?, ?, '', 'event', 0, 60, NULL, '{}', 1, 1, 1)`,
    )
    for (let index = 0; index < MAX_TEMPLATES; index += 1) {
      templateInsert.run(ALICE, `quota-template-${index}`, `Template ${index}`, `Title ${index}`)
    }
    await expect(insertTemplateRow(db, ALICE, 'overflow-template', {
      name: 'Overflow', title: 'Overflow', description: '', kind: 'event', allDay: false,
      durationMinutes: 60, color: null,
    })).rejects.toMatchObject({ status: 409 })

    const linkInsert = sqlite.prepare(
      `INSERT INTO calendar_scheduling_links
         (user_id, id, calendar_id, slug, title, duration_minutes, days_json, start_hour, end_hour, enabled, created_at, updated_at)
       VALUES (?, ?, 'quota-calendar', ?, 'Link', 30, '[1]', 9, 17, 1, 1, 1)`,
    )
    for (let index = 0; index < MAX_SCHEDULING_LINKS; index += 1) {
      linkInsert.run(ALICE, `quota-link-${index}`, `quota-slug-${index}`)
    }
    const calendar = await defaultCalendar()
    expect((await call('POST', '/api/calendar/scheduling-links', { calendarId: calendar.id })).status).toBe(409)

    const resourceInsert = sqlite.prepare(
      'INSERT INTO calendar_resources (user_id, id, calendar_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)',
    )
    for (let index = 0; index < MAX_CALENDARS; index += 1) {
      resourceInsert.run(ALICE, `quota-resource-${index}`, `quota-resource-calendar-${index}`, `Resource ${index}`)
    }
    const calendarsBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(ALICE)
    expect((await call('POST', '/api/calendar/resources', { name: 'Overflow room' })).status).toBe(409)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_calendars WHERE user_id = ?').get(ALICE)).toEqual(calendarsBefore)
  })
})

describe('resources, booking links and snoozes', () => {
  it('creates a resource calendar and exposes it in meta', async () => {
    const response = await call('POST', '/api/calendar/resources', { name: 'Room 3', capacity: 8 })
    expect(response.status).toBe(200)
    const created = await json<{ resource: { calendarId: string; name: string; capacity: number } }>(response)
    const meta = await json<CalendarMetaDto>(await call('GET', '/api/calendar/meta'))
    expect(meta.resources?.some(resource => resource.id && resource.name === 'Room 3')).toBe(true)
    expect(meta.calendars.some(calendar => calendar.id === created.resource.calendarId)).toBe(true)
  })

  it('publishes a booking link, returns busy blocks and books a slot into the owner calendar', async () => {
    const calendar = await defaultCalendar()
    const link = await json<{ link: { id: string; slug: string } }>(await call('POST', '/api/calendar/scheduling-links', {
      calendarId: calendar.id,
      title: 'Intro call',
      durationMinutes: 30,
      days: [0, 1, 2, 3, 4, 5, 6],
      startHour: 0,
      endHour: 24,
    }))
    const publicRead = await json<{ busy: unknown[] }>(await call('GET', `/api/public/calendar/scheduling/${link.link.slug}`))
    expect(Array.isArray(publicRead.busy)).toBe(true)

    const startMs = Math.ceil((Date.now() + 3 * 86_400_000) / 1_800_000) * 1_800_000
    const booked = await call('POST', `/api/public/calendar/scheduling/${link.link.slug}/book`, {
      startMs,
      name: 'Dana',
      email: 'dana@example.com',
    })
    expect(booked.status).toBe(200)
    expect(await booked.json()).toEqual({ startMs, endMs: startMs + 30 * 60_000 })

    user = ALICE
    const from = new Date(startMs - 3_600_000).toISOString()
    const to = new Date(startMs + 3_600_000).toISOString()
    const events = await range(from, to)
    expect(events.events.some(event => event.title.includes('Dana'))).toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attendees').get()).toEqual({ count: 1 })
  })

  it('exposes only linked-calendar busy time, excluding private and shared calendars', async () => {
    const calendar = await defaultCalendar()
    const link = await bookingLink(calendar.id)
    const privateCalendar = await json<{ calendar: CalendarDto }>(await call('POST', '/api/calendar/calendars', { name: 'Private' }))
    const linkedStart = alignedStart(2 * 86_400_000)
    const bookedStart = alignedStart(3 * 86_400_000)
    await json(await call('POST', '/api/calendar/events', timedEvent(calendar.id, linkedStart)))
    await json(await call('POST', '/api/calendar/events', timedEvent(calendar.id, linkedStart + 30 * 60_000)))
    await json(await call('POST', '/api/calendar/events', timedEvent(privateCalendar.calendar.id, bookedStart)))

    user = BOB
    const bobCalendar = await defaultCalendar()
    await json(await call('POST', '/api/calendar/events', timedEvent(bobCalendar.id, bookedStart)))
    await invite(bobCalendar.id, 'alice', 'reader')
    user = ALICE
    await accept(BOB, bobCalendar.id)

    const publicRead = await json<{ busy: Array<{ startMs: number; endMs: number }> }>(
      await call('GET', `/api/public/calendar/scheduling/${link.slug}`),
    )
    expect(publicRead.busy).toEqual([{ startMs: linkedStart, endMs: linkedStart + 90 * 60_000 }])
    const throttleKeys = sqlite.prepare('SELECT key FROM login_attempts').all() as Array<{ key: string }>
    expect(throttleKeys.some(row => row.key === `calendar-booking:owner:${ALICE}:day`)).toBe(true)
    const booked = await call('POST', `/api/public/calendar/scheduling/${link.slug}/book`, {
      startMs: bookedStart,
      name: 'Dana',
      email: 'dana@example.com',
    })
    expect(booked.status).toBe(200)
  })

  it('allows only one concurrent booking for the same slot', async () => {
    const link = await bookingLink((await defaultCalendar()).id)
    const startMs = alignedStart()
    const answers = await Promise.all([
      call('POST', `/api/public/calendar/scheduling/${link.slug}/book`, { startMs, name: 'Dana', email: 'dana@example.com' }),
      call('POST', `/api/public/calendar/scheduling/${link.slug}/book`, { startMs, name: 'Eli', email: 'eli@example.com' }),
    ])
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409])
    expect(sqlite.prepare(
      `SELECT COUNT(*) AS count FROM calendar_event_calendars m
         JOIN calendar_events e ON e.user_id = m.user_id AND e.id = m.event_id
        WHERE m.calendar_id = ? AND e.start_ms = ?`,
    ).get(link.calendarId, startMs)).toEqual({ count: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attendees').get()).toEqual({ count: 1 })
  })

  it('does not expose internal link, calendar or event ids in public responses', async () => {
    const calendar = await defaultCalendar()
    const ownerLink = await bookingLink(calendar.id)
    expect(ownerLink).toHaveProperty('id')
    expect(ownerLink).toHaveProperty('calendarId', calendar.id)
    const publicRead = await json<{ link: Record<string, unknown> }>(
      await call('GET', `/api/public/calendar/scheduling/${ownerLink.slug}`),
    )
    expect(publicRead.link).toMatchObject({ slug: ownerLink.slug, title: 'Intro call' })
    expect(publicRead.link).not.toHaveProperty('id')
    expect(publicRead.link).not.toHaveProperty('calendarId')
    expect(publicRead.link).not.toHaveProperty('userId')
    const booked = await json<Record<string, unknown>>(await call('POST', `/api/public/calendar/scheduling/${ownerLink.slug}/book`, {
      startMs: alignedStart(),
      name: 'Dana',
    }))
    expect(Object.keys(booked).sort()).toEqual(['endMs', 'startMs'])
  })

  it.each([
    ['past start', { startMs: alignedStart(-15 * 60_000) }],
    ['start beyond fourteen days', { startMs: alignedStart(14 * 86_400_000 + SLOT_MS) }],
    ['unaligned start', { startMs: alignedStart() + 7 * 60_000 }],
    ['missing name', { name: '   ' }],
    ['long name', { name: 'x'.repeat(121) }],
    ['invalid email', { email: 'not-an-email' }],
    ['non-string email', { email: 123 }],
    ['long email', { email: `${'x'.repeat(200)}@example.com` }],
  ])('rejects a booking with %s', async (_label, patch) => {
    const link = await bookingLink((await defaultCalendar()).id)
    const answer = await call('POST', `/api/public/calendar/scheduling/${link.slug}/book`, {
      startMs: alignedStart(),
      name: 'Dana',
      email: 'dana@example.com',
      ...patch,
    })
    expect(answer.status).toBe(400)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events').get()).toEqual({ count: 0 })
  })

  it('fails closed when the linked-calendar event query is truncated', async () => {
    const link = await bookingLink((await defaultCalendar()).id)
    const start = alignedStart()
    const insert = sqlite.prepare(
      `INSERT INTO calendar_events
         (user_id, id, title, start_value, start_type, start_ms, end_value, end_type, end_ms, created_at, updated_at)
       VALUES (?, ?, 'Busy', ?, 'datetime', ?, ?, 'datetime', ?, 1, 1)`,
    )
    const membership = sqlite.prepare('INSERT INTO calendar_event_calendars (user_id, event_id, calendar_id) VALUES (?, ?, ?)')
    const value = new Date(start - 1000).toISOString().slice(0, 19)
    sqlite.exec('BEGIN')
    try {
      for (let index = 0; index <= MAX_EVENTS_PER_QUERY; index += 1) {
        insert.run(ALICE, `booking-overflow-${index}`, value, start - 1000, value, start + 60 * 60_000)
        membership.run(ALICE, `booking-overflow-${index}`, link.calendarId)
      }
      sqlite.exec('COMMIT')
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
    expect((await call('GET', `/api/public/calendar/scheduling/${link.slug}`)).status).toBe(503)
    expect((await call('POST', `/api/public/calendar/scheduling/${link.slug}/book`, {
      startMs: start,
      name: 'Dana',
    })).status).toBe(503)
  })

  it('fails closed when recurring busy expansion is truncated', async () => {
    const link = await bookingLink((await defaultCalendar()).id)
    const start = alignedStart(86_400_000)
    const value = new Date(start).toISOString().replace('Z', '[UTC]')
    const insert = sqlite.prepare(
      `INSERT INTO calendar_events
         (user_id, id, title, start_value, start_type, start_ms, end_value, end_type, end_ms,
          recurrence_rule, created_at, updated_at)
       VALUES (?, ?, 'Busy', ?, 'zoned', ?, ?, 'zoned', ?, 'FREQ=DAILY;COUNT=15', 1, 1)`,
    )
    const membership = sqlite.prepare('INSERT INTO calendar_event_calendars (user_id, event_id, calendar_id) VALUES (?, ?, ?)')
    const masters = Math.ceil((MAX_RECURRENCE_OCCURRENCES + 1) / RECURRING_OCCURRENCES_PER_MASTER)
    for (let index = 0; index < masters; index += 1) {
      const id = `booking-recurring-overflow-${index}`
      insert.run(ALICE, id, value, start, value, start + 60_000)
      membership.run(ALICE, id, link.calendarId)
    }
    expect((await call('GET', `/api/public/calendar/scheduling/${link.slug}`)).status).toBe(503)
  })

  it('parks a snooze and filters search by attendee, recurrence and task status', async () => {
    const calendar = await defaultCalendar()
    const created = await json<{ event: CalendarEventDto }>(await call('POST', '/api/calendar/events', eventBody(calendar.id, {
      title: 'Guest sync',
      recurrenceRule: 'FREQ=WEEKLY',
    })))
    await json(await call('PUT', `/api/calendar/events/${created.event.id}/attendees`, {
      rev: created.event.rev,
      attendees: [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }],
    }))
    const snooze = await call('POST', `/api/calendar/events/${created.event.id}/snooze`, { minutes: 10 })
    expect(snooze.status).toBe(200)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_reminder_snoozes').get()).toEqual({ count: 1 })

    const byGuest = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&attendee=guest%40example.com'))
    expect(byGuest.results).toHaveLength(1)
    const oneOff = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&recurring=0'))
    expect(oneOff.results).toHaveLength(0)
    const recurring = await json<{ results: unknown[] }>(await call('GET', '/api/calendar/events/search?q=&recurring=1'))
    expect(recurring.results).toHaveLength(1)
  })
})

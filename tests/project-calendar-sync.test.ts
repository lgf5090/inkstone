// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Temporal } from 'temporal-polyfill'
import { createApp } from '../src/worker/app'
import { createSession } from '../src/worker/lib/session-store'
import { CLIENT_HEADER, LEGACY_SESSION_COOKIE } from '@shared/constants'
import { temporalValueToEpochMs, toTemporalValue } from '@shared/calendar/model'
import type { Env } from '../src/worker/env'
import type { ProjectBoard, ProjectCard } from '@shared/project/model'
import { CalendarStore } from '../src/worker/calendar/store'
import { testBindings } from './doubles/bindings'
import { makeD1 } from './doubles/d1-sqlite'

const app = createApp()
let sqlite: DatabaseSync
let env: Env
let token: string
const propertyId = `p${'a'.repeat(26)}`

beforeAll(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await app.fetch(new Request('http://localhost/api/health'), env)
  const now = Date.now()
  sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, role, created_at, last_seen_at)
    VALUES ('alice', 'alice', 'hash', 'alice', 'alice', 'member', ?, ?)`).run(now, now)
  token = await createSession(env.DB, 'alice')
})

beforeEach(() => {
  sqlite.exec(`DELETE FROM project_calendar_links; DELETE FROM project_cards; DELETE FROM project_properties; DELETE FROM project_board_members; DELETE FROM project_boards;
    DELETE FROM calendar_event_calendars; DELETE FROM calendar_events; DELETE FROM calendar_calendars`)
})

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return app.fetch(new Request(`http://localhost/api/project${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env)
}

function zoned(stamp: number) {
  return toTemporalValue(Temporal.Instant.fromEpochMilliseconds(stamp).toZonedDateTimeISO('UTC'))
}

async function fixture() {
  const board = ((await (await req('POST', '/boards', {
    title: 'Calendar bridge',
    cardProperties: [{ id: propertyId, name: 'Due', type: 'date', options: [] }],
  })).json()) as { board: ProjectBoard }).board
  const card = ((await (await req('POST', `/boards/${board.id}/cards`, {
    title: 'Calendar card',
    values: { [propertyId]: JSON.stringify({ from: Date.UTC(2026, 10, 27, 9), to: Date.UTC(2026, 10, 27, 10), includeTime: true, timeZone: 'UTC' }) },
  })).json()) as { card: ProjectCard }).card
  const calendars = new CalendarStore(env.DB, 'alice')
  const calendar = await calendars.createCalendar({ name: 'Work' })
  const event = await calendars.createEvent({
    title: 'Original event',
    start: zoned(Date.UTC(2026, 10, 27, 9)),
    end: zoned(Date.UTC(2026, 10, 27, 10)),
    calendarIds: [calendar.id],
  })
  return { board, card, calendar, event }
}

describe('project and calendar two-way bridge', () => {
  it('updates the linked event from the card and the card from the event', async () => {
    const { card, calendar, event } = await fixture()
    const linked = await req('POST', `/cards/${card.id}/calendar-links`, { calendarId: calendar.id, eventId: event.id, propertyId })
    expect(linked.status, await linked.clone().text()).toBe(201)

    const nextStart = Date.UTC(2026, 10, 28, 11)
    const nextEnd = Date.UTC(2026, 10, 28, 12)
    const patched = await req('PATCH', `/cards/${card.id}`, {
      title: 'Renamed card',
      values: { [propertyId]: JSON.stringify({ from: nextStart, to: nextEnd, includeTime: true, timeZone: 'UTC' }) },
    })
    expect(patched.status).toBe(200)
    const store = new CalendarStore(env.DB, 'alice')
    const updated = await store.getEvent(event.id)
    expect(updated?.title).toBe('Renamed card')
    expect(temporalValueToEpochMs(updated!.start, 'UTC')).toBe(nextStart)
    expect(temporalValueToEpochMs(updated!.end, 'UTC')).toBe(nextEnd)

    const eventStart = Date.UTC(2026, 10, 29, 8)
    const eventEnd = Date.UTC(2026, 10, 29, 9)
    const calendarResponse = await app.fetch(new Request(`http://localhost/api/calendar/events/${event.id}`, {
      method: 'PATCH',
      headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: updated!.rev, start: zoned(eventStart), end: zoned(eventEnd) }),
    }), env)
    expect(calendarResponse.status, await calendarResponse.clone().text()).toBe(200)
    const cardAfter = ((await (await req('GET', `/cards/${card.id}`)).json()) as { card: ProjectCard }).card
    expect(JSON.parse(cardAfter.values[propertyId]!)).toMatchObject({ from: eventStart, to: eventEnd, includeTime: true })

    const deleted = await app.fetch(new Request(`http://localhost/api/calendar/events/${event.id}?rev=${updated!.rev + 1}`, {
      method: 'DELETE',
      headers: { Cookie: `${LEGACY_SESSION_COOKIE}=${token}`, [CLIENT_HEADER]: '1' },
    }), env)
    expect(deleted.status).toBe(204)
    const cleared = ((await (await req('GET', `/cards/${card.id}`)).json()) as { card: ProjectCard }).card
    expect(cleared.values[propertyId]).toBeUndefined()
  })
})

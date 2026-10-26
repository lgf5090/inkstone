// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarAttachmentDto, CalendarDto, CalendarEventDto } from '../src/shared/calendar/model'
import { MAX_ATTACHMENTS_PER_EVENT } from '../src/shared/calendar/model'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { errorResponse } from '../src/worker/lib/errors'
import { calendarRoutes } from '../src/worker/routes/calendar'
import { calendarAttachmentRoutes } from '../src/worker/routes/calendar-attachments'
import { filesRoutes } from '../src/worker/routes/files'
import type { AppBindings, Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings, testR2Bucket, type TestR2Bucket } from './doubles/bindings'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const mocks = vi.hoisted(() => ({ userId: '' }))

vi.mock('../src/worker/middleware/auth', () => ({
  requireAuth: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', mocks.userId)
    await next()
  },
}))

let sqlite: DatabaseSync
let env: Env
let bucket: TestR2Bucket

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((err, c) => errorResponse(c, err))
  // The file door resolves its own session; the account the test drives is injected the same way the
  // task attachment suite does it.
  instance.use('/api/files/*', async (c, next) => {
    c.set('userId', mocks.userId)
    await next()
  })
  instance.route('/api/files', filesRoutes)
  instance.route('/api/calendar', calendarAttachmentRoutes)
  instance.route('/api/calendar', calendarRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown, userId = ALICE): Promise<Response> {
  mocks.userId = userId
  const form = body instanceof FormData ? body : undefined
  return await app().request(`/api/calendar${path}`, {
    method,
    ...(form
      ? { body: form }
      : body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }, env)
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return await response.json() as T
}

async function download(id: string, userId = ALICE): Promise<Response> {
  mocks.userId = userId
  return await app().request(`/api/files/${id}`, {}, env)
}

function fileForm(file: File | null, field = 'file'): FormData {
  const form = new FormData()
  if (file) form.append(field, file)
  return form
}

async function newCalendar(name: string, readOnly = false): Promise<CalendarDto> {
  const answer = await json<{ calendar: CalendarDto }>(await call('POST', '/calendars', { name, color: '#112233', readOnly }))
  return answer.calendar
}

async function newEvent(calendarId: string, title = 'Review'): Promise<CalendarEventDto> {
  const answer = await json<{ event: CalendarEventDto }>(await call('POST', '/events', {
    title,
    start: { value: '2026-11-20T09:00:00', type: 'datetime' },
    end: { value: '2026-11-20T10:00:00', type: 'datetime' },
    calendarId,
  }))
  return answer.event
}

async function upload(eventId: string, name: string, type = 'text/plain', bytes = [104, 105], userId = ALICE): Promise<Response> {
  return await call('POST', `/events/${eventId}/attachments`, fileForm(new File([new Uint8Array(bytes)], name, { type })), userId)
}

function count(sql: string, ...values: Array<string | number>): number {
  return Number((sqlite.prepare(sql).get(...values) as { n: number }).n)
}

function cleanupTargets(): string[] {
  return (sqlite.prepare('SELECT object_key FROM attachment_cleanup ORDER BY object_key').all() as Array<{ object_key: string }>)
    .map(row => row.object_key)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  bucket = testR2Bucket()
  env = testBindings(makeD1(sqlite), { FILES: bucket })
  mocks.userId = ALICE
})

describe('an event attachment', () => {
  it('files a picture under the images folder and lists it back', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    // A one-pixel PNG: the pipeline sniffs the signature, so this is stored as an image, not as text.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const response = await upload(event.id, 'boarding.png', 'image/png', png)
    expect(response.status).toBe(201)

    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(response)
    expect(attachment).toMatchObject({ filename: 'boarding.png', size: png.length, width: null, height: null })
    expect(attachment.url).toBe(`/api/files/${attachment.id}`)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE user_id = ? AND event_id = ?', ALICE, event.id)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ? AND scope = ?', attachment.id, 'calendar')).toBe(1)

    const listed = await json<{ attachments: CalendarAttachmentDto[] }>(await call('GET', `/events/${event.id}/attachments`))
    expect(listed.attachments.map(item => item.id)).toEqual([attachment.id])
  })

  it('files a document under the docx folder', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const response = await upload(event.id, 'agenda.pdf', 'application/pdf', [0x25, 0x50, 0x44, 0x46])
    expect(response.status).toBe(201)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(response)
    const row = sqlite.prepare('SELECT object_key FROM attachments WHERE id = ?').get(attachment.id) as { object_key: string }
    expect(row.object_key).toBe(`calendar/docx/${attachment.id}.pdf`)
    expect(bucket.objects.has(row.object_key)).toBe(true)
  })

  it('serves the bytes through the account file door', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    const response = await download(attachment.id)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([104, 105]))
    // The file door's contract for someone else's id is `unauthenticated`, not a 404 (files.ts).
    expect((await download(attachment.id, BOB)).status).toBe(401)
  })

  it('refuses a form without a file', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const response = await call('POST', `/events/${event.id}/attachments`, fileForm(null))
    expect(response.status).toBe(400)
  })

  it('refuses the file after the event is full', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'first.txt'))
    for (let index = 1; index < MAX_ATTACHMENTS_PER_EVENT; index += 1) {
      sqlite.prepare(
        `INSERT INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at) VALUES (?, ?, ?, ?)`,
      ).run(ALICE, `filler-${index}`, event.id, index)
    }
    const response = await upload(event.id, 'last.txt')
    expect(response.status).toBe(409)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE event_id = ?', event.id)).toBe(MAX_ATTACHMENTS_PER_EVENT)
    // The refusal happens before the upload, so nothing was written for it.
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE user_id = ?', ALICE)).toBe(1)
    expect(attachment.id).toBeTruthy()
  })

  it('refuses another account at every door', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    expect((await call('GET', `/events/${event.id}/attachments`, undefined, BOB)).status).toBe(404)
    expect((await upload(event.id, 'other.txt', 'text/plain', [104], BOB)).status).toBe(404)
    expect((await call('DELETE', `/events/${event.id}/attachments/${attachment.id}`, undefined, BOB)).status).toBe(404)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(1)
  })

  it('refuses an upload to a read-only calendar', async () => {
    const calendar = await newCalendar('Synced')
    const event = await newEvent(calendar.id)
    const patched = await call('PATCH', `/calendars/${calendar.id}`, { readOnly: true, rev: calendar.rev })
    expect(patched.ok).toBe(true)
    expect((await upload(event.id, 'notes.txt')).status).toBe(403)
  })
})

describe('removing an attachment', () => {
  it('takes the link, the row and the object with it', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    const response = await call('DELETE', `/events/${event.id}/attachments/${attachment.id}`)
    expect(response.status).toBe(204)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE attachment_id = ?', attachment.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(0)
    expect(cleanupTargets()).toEqual([`r2:calendar/docx/${attachment.id}.txt`])
  })

  it('answers 404 for a file that is not on that event', async () => {
    const calendar = await newCalendar('Trips')
    const first = await newEvent(calendar.id, 'First')
    const second = await newEvent(calendar.id, 'Second')
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(first.id, 'notes.txt'))
    expect((await call('DELETE', `/events/${second.id}/attachments/${attachment.id}`)).status).toBe(404)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(1)
  })
})

describe('deleting what an attachment hangs on', () => {
  it('deletes the file with the event', async () => {
    const calendar = await newCalendar('Trips')
    const event = await newEvent(calendar.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    expect((await call('DELETE', `/events/${event.id}?rev=${event.rev}`)).status).toBe(204)
    expect(count('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?', event.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE event_id = ?', event.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(0)
    expect(cleanupTargets()).toEqual([`r2:calendar/docx/${attachment.id}.txt`])
  })

  it('keeps the file when the event survives in another calendar', async () => {
    const doomed = await newCalendar('Doomed')
    const keeper = await newCalendar('Keeper')
    const event = await newEvent(doomed.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    const shared = await call('PATCH', `/events/${event.id}`, { calendarIds: [doomed.id, keeper.id], rev: event.rev })
    expect(shared.ok).toBe(true)

    expect((await call('DELETE', `/calendars/${doomed.id}?mode=delete&rev=${doomed.rev}`)).status).toBe(204)
    expect(count('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?', event.id)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE attachment_id = ?', attachment.id)).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(1)
    expect(cleanupTargets()).toEqual([])
  })

  it('deletes the file of an event only that calendar held', async () => {
    const doomed = await newCalendar('Doomed')
    await newCalendar('Elsewhere')
    const event = await newEvent(doomed.id)
    const { attachment } = await json<{ attachment: CalendarAttachmentDto }>(await upload(event.id, 'notes.txt'))
    expect((await call('DELETE', `/calendars/${doomed.id}?mode=delete&rev=${doomed.rev}`)).status).toBe(204)
    expect(count('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?', event.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM calendar_event_attachments WHERE event_id = ?', event.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM attachments WHERE id = ?', attachment.id)).toBe(0)
    expect(cleanupTargets()).toEqual([`r2:calendar/docx/${attachment.id}.txt`])
  })
})

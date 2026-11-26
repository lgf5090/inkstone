// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import {
  applyBackupCalendar,
  readBackupCalendar,
} from '../src/worker/calendar/backup'
import { parseEventInput } from '../src/worker/calendar/validation'
import { CountdownStore } from '../src/worker/calendar/countdowns'
import { listContacts } from '../src/worker/calendar/contacts'
import { listMembers } from '../src/worker/calendar/members'
import { listTemplateRows } from '../src/worker/calendar/templates'
import { listResources } from '../src/worker/calendar/resources'
import { listSchedulingLinks } from '../src/worker/calendar/scheduling'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const CAROL = 'user-carol'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
  const store = new CalendarStore(db, ALICE)
  const [calendar] = await store.ensureDefaultCalendar()
  await store.createEvent(parseEventInput({
    title: 'Backed up meeting',
    description: 'Notes',
    start: { value: '2026-10-26T09:00:00', type: 'datetime' },
    end: { value: '2026-10-26T10:00:00', type: 'datetime' },
    calendarIds: [calendar!.id],
    meta: { location: 'Room 1' },
    icon: true,
  }, { defaultTimeZone: 'UTC' }))
})

describe('calendar backup', () => {
  it('round-trips calendars, groups and events into another account', async () => {
    const text = await readBackupCalendar(db, ALICE)
    expect(text).not.toBeNull()
    const summary = await applyBackupCalendar(db, BOB, text!)
    expect(summary).toMatchObject({ calendars: 1, groups: 0, events: 1 })

    const bob = new CalendarStore(db, BOB)
    const meta = await bob.meta()
    expect(meta.calendars).toHaveLength(1)
    expect(meta.calendars[0]?.name).toBe('Calendar')
    const events = await bob.listAllEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      title: 'Backed up meeting',
      description: 'Notes',
      meta: { location: 'Room 1' },
      source: 'local',
    })
  })

  it('is additive and idempotent when the same document is applied twice', async () => {
    const text = await readBackupCalendar(db, ALICE)
    await applyBackupCalendar(db, BOB, text!)
    await applyBackupCalendar(db, BOB, text!)
    const bob = new CalendarStore(db, BOB)
    const meta = await bob.meta()
    expect(meta.calendars).toHaveLength(1)
    expect(await bob.listAllEvents()).toHaveLength(1)
  })

  it('round-trips reminders, attendees, attachment links and calendar auxiliary rows', async () => {
    const store = new CalendarStore(db, ALICE)
    const [calendar] = await store.listCalendars()
    const [event] = await store.listAllEvents()
    await store.setEventReminders(event!.id, [5], event!.rev)
    await store.setEventAttendees(event!.id, [{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }], event!.rev + 1)
    sqlite.prepare(`INSERT INTO attachments
      (id, user_id, scope, filename, mime, size, sha256, object_key, storage, created_at)
      VALUES ('calendar-file', ?, 'calendar', 'file.txt', 'text/plain', 4, 'hash', 'calendar/user/file.txt', 'r2', 1)`)
      .run(ALICE)
    sqlite.prepare('INSERT INTO calendar_event_attachments (user_id, attachment_id, event_id, created_at) VALUES (?, ?, ?, ?)')
      .run(ALICE, 'calendar-file', event!.id, 1)
    for (const [userId, username] of [[BOB, 'bob'], [CAROL, 'carol']] as const) {
      sqlite.prepare(`INSERT INTO users (id, username, password_hash, login, name, avatar_url, role, settings, created_at, last_seen_at)
        VALUES (?, ?, 'hash', ?, ?, '', 'member', '{}', 1, 1)`).run(userId, username, username, username)
    }
    sqlite.prepare(`INSERT INTO calendar_members
      (owner_user_id, calendar_id, member_user_id, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 'reader', 'accepted', 1, 1)`).run(ALICE, calendar!.id, BOB)
    sqlite.prepare(`INSERT INTO calendar_contacts (user_id, id, name, email, birthday, created_at, updated_at, rev)
      VALUES (?, 'contact-1', 'Contact', 'contact@example.com', '1990-01-02', 1, 1, 1)`).run(ALICE)
    sqlite.prepare(`INSERT INTO calendar_event_templates
      (user_id, id, name, title, description, kind, all_day, duration_minutes, color, meta_json, created_at, updated_at, rev)
      VALUES (?, 'template-1', 'Template', 'Review', '', 'event', 0, 30, NULL, '{}', 1, 1, 1)`).run(ALICE)
    sqlite.prepare(`INSERT INTO calendar_countdowns
      (user_id, id, title, target_date, repeat_mode, lunar_month, lunar_day, lunar_leap, note, color, pinned, created_at, updated_at, rev)
      VALUES (?, 'countdown-1', 'Launch', '2026-12-01', 'none', NULL, NULL, 0, '', '#e5484d', 0, 1, 1, 1)`).run(ALICE)
    sqlite.prepare(`INSERT INTO calendar_resources (user_id, id, calendar_id, name, capacity, created_at, updated_at)
      VALUES (?, 'resource-1', ?, 'Room', 8, 1, 1)`).run(ALICE, calendar!.id)
    sqlite.prepare(`INSERT INTO calendar_scheduling_links
      (user_id, id, calendar_id, slug, title, duration_minutes, days_json, start_hour, end_hour, enabled, created_at, updated_at)
      VALUES (?, 'link-1', ?, 'backup-slug', 'Intro', 30, '[1]', 9, 17, 1, 1, 1)`).run(ALICE, calendar!.id)

    const text = await readBackupCalendar(db, ALICE)
    const document = JSON.parse(text!) as Record<string, unknown[]>
    expect(document.reminders).toHaveLength(1)
    expect(document.attendees).toHaveLength(1)
    expect(document.attachments).toHaveLength(1)
    expect(document.members).toHaveLength(1)
    expect(document.contacts).toHaveLength(1)
    expect(document.templates).toHaveLength(1)
    expect(document.countdowns).toHaveLength(1)
    expect(document.resources).toHaveLength(1)
    expect(document.schedulingLinks).toHaveLength(1)

    await applyBackupCalendar(db, CAROL, text!)
    await applyBackupCalendar(db, CAROL, text!)
    const restored = new CalendarStore(db, CAROL)
    expect((await restored.eventReminders([event!.id])).get(event!.id)).toEqual([5])
    expect(await restored.eventAttendees(event!.id)).toEqual([{ email: 'guest@example.com', name: 'Guest', status: 'accepted' }])
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attachments WHERE user_id = ? AND event_id = ?').get(CAROL, event!.id))
      .toEqual({ count: 1 })
    expect(await listMembers(db, CAROL, calendar!.id)).toHaveLength(1)
    expect(await listContacts(db, CAROL)).toHaveLength(1)
    expect(await listTemplateRows(db, CAROL)).toHaveLength(1)
    expect(await new CountdownStore(db, CAROL).list()).toHaveLength(1)
    expect(await listResources(db, CAROL)).toHaveLength(1)
    expect(await listSchedulingLinks(db, CAROL)).toHaveLength(1)
  })

  it('reads all event memberships in one query', async () => {
    const store = new CalendarStore(db, ALICE)
    const prepare = vi.spyOn(db, 'prepare')
    await store.listAllEvents()
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('validates restored event extras instead of trusting the document', async () => {
    const text = await readBackupCalendar(db, ALICE)
    const document = JSON.parse(text!) as Record<string, unknown[]>
    const [event] = await new CalendarStore(db, ALICE).listAllEvents()
    document.attendees = [{ event_id: event!.id, email: 'not-an-email', name: 'Guest', status: 'accepted', created_at: 1 }]
    await expect(applyBackupCalendar(db, BOB, JSON.stringify(document))).rejects.toMatchObject({ status: 400 })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_event_attendees WHERE user_id = ?').get(BOB)).toEqual({ count: 0 })
  })

  it('refuses a document that is not a calendar backup', async () => {
    await expect(applyBackupCalendar(db, BOB, '{"version":1,"calendars":[{"id":"../x","name":"x"}]}'))
      .rejects.toThrow()
    await expect(applyBackupCalendar(db, BOB, 'not json')).rejects.toThrow()
  })
})

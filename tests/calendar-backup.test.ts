// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { CalendarStore } from '../src/worker/calendar/store'
import {
  applyBackupCalendar,
  readBackupCalendar,
} from '../src/worker/calendar/backup'
import { parseEventInput } from '../src/worker/calendar/validation'
import { makeD1 } from './doubles/d1-sqlite'

const ALICE = 'user-alice'
const BOB = 'user-bob'

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

  it('refuses a document that is not a calendar backup', async () => {
    await expect(applyBackupCalendar(db, BOB, '{"version":1,"calendars":[{"id":"../x","name":"x"}]}'))
      .rejects.toThrow()
    await expect(applyBackupCalendar(db, BOB, 'not json')).rejects.toThrow()
  })
})

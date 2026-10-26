// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import {
  CALENDAR_REQUIRED_COLUMNS,
  CALENDAR_REQUIRED_INDEXES,
  CALENDAR_REQUIRED_TABLES,
  CALENDAR_SCHEMA_STATEMENTS,
} from '../src/worker/calendar/schema'

let sqlite: DatabaseSync

function applySchema(): void {
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
}

function tables(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function indexes(): Set<string> {
  const rows = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function columns(table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function primaryKey(table: string): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  return rows.filter((row) => row.pk > 0).sort((left, right) => left.pk - right.pk).map((row) => row.name)
}

function insertCalendar(userId: string, id: string, isDefault = 0): void {
  sqlite.prepare(
    `INSERT INTO calendar_calendars (
       user_id, id, name, color, dark_color, is_default, position, created_at, updated_at, rev
     ) VALUES (?, ?, 'Calendar', '#112233', '#445566', ?, 0, 1, 1, 1)`,
  ).run(userId, id, isDefault)
}

function insertEvent(userId: string, id: string, source = 'local', externalId: string | null = null, externalScope = ''): void {
  sqlite.prepare(
    `INSERT INTO calendar_events (
       user_id, id, title, start_value, start_type, start_ms, end_value, end_type, end_ms,
       calendar_source, external_scope, external_id, created_at, updated_at, rev
     ) VALUES (?, ?, 'Event', '2026-10-26T09:00:00', 'datetime', 1, '2026-10-26T10:00:00', 'datetime', 2,
               ?, ?, ?, 1, 1, 1)`,
  ).run(userId, id, source, externalScope, externalId)
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  applySchema()
})

describe('the calendar tables', () => {
  it('are wired into the schema every boot runs', () => {
    for (const statement of CALENDAR_SCHEMA_STATEMENTS) {
      expect(SCHEMA_STATEMENTS.some((candidate) => candidate.includes(statement.slice(0, 60)))).toBe(true)
    }
  })

  it('create every declared table', () => {
    const present = tables()
    for (const table of CALENDAR_REQUIRED_TABLES) expect(present.has(table)).toBe(true)
    expect(CALENDAR_REQUIRED_TABLES).toHaveLength(15)
  })

  it('create every declared index', () => {
    const present = indexes()
    for (const index of CALENDAR_REQUIRED_INDEXES) expect(present.has(index)).toBe(true)
  })

  it('carry every column the boot checks for', () => {
    for (const [table, required] of Object.entries(CALENDAR_REQUIRED_COLUMNS)) {
      const present = columns(table)
      for (const column of required) expect(present.has(column), `${table}.${column}`).toBe(true)
    }
  })

  it('scope every row to an account, with user_id leading each key', () => {
    for (const table of CALENDAR_REQUIRED_TABLES) {
      expect(columns(table).has('user_id')).toBe(true)
      expect(primaryKey(table)[0], `${table} must lead its key with user_id`).toBe('user_id')
    }
  })

  it('is idempotent and keeps the rows already stored', () => {
    insertCalendar('u1', 'c1', 1)
    insertEvent('u1', 'e1')
    expect(() => applySchema()).not.toThrow()
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM calendar_calendars`).get()).toEqual({ count: 1 })
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM calendar_events`).get()).toEqual({ count: 1 })
  })
})

describe('the calendar constraints', () => {
  it('keep one default calendar per account', () => {
    insertCalendar('u1', 'c1', 1)
    expect(() => insertCalendar('u1', 'c2', 1)).toThrow()
    expect(() => insertCalendar('u2', 'c2', 1)).not.toThrow()
    expect(() => insertCalendar('u1', 'c3', 0)).not.toThrow()
  })

  it('keep group names unique without case and scoped to the account', () => {
    sqlite.prepare(
      `INSERT INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
       VALUES ('u1', 'g1', 'Work', 0, 1, 1)`,
    ).run()
    expect(() => sqlite.prepare(
      `INSERT INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
       VALUES ('u1', 'g2', 'work', 1, 1, 1)`,
    ).run()).toThrow()
    expect(() => sqlite.prepare(
      `INSERT INTO calendar_groups (user_id, id, name, position, created_at, updated_at)
       VALUES ('u2', 'g2', 'work', 1, 1, 1)`,
    ).run()).not.toThrow()
  })

  it('keep external ids unique inside a source scope while allowing many local events', () => {
    insertEvent('u1', 'e1')
    insertEvent('u1', 'e2')
    insertEvent('u1', 'e3', 'caldav', 'remote-1', 'cal-a')
    expect(() => insertEvent('u1', 'e4', 'caldav', 'remote-1', 'cal-a')).toThrow()
    expect(() => insertEvent('u1', 'e5', 'caldav', 'remote-1', 'cal-b')).not.toThrow()
    expect(() => insertEvent('u1', 'e6', 'google', 'remote-1', 'cal-a')).not.toThrow()
    expect(() => insertEvent('u2', 'e4', 'caldav', 'remote-1', 'cal-a')).not.toThrow()
  })

  it('allow the same id in two accounts but not twice in one', () => {
    insertCalendar('u1', 'same')
    insertCalendar('u2', 'same')
    expect(() => insertCalendar('u1', 'same')).toThrow()
  })
})

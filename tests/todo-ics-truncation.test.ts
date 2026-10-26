// @vitest-environment node
/**
 * L-05: a subscription that had to stop at the ceiling says so in its own document.
 *
 * `loadFeedTasks` ends in `LIMIT MAX_TASKS_PER_QUERY`, and that ceiling is a deliberate brake on a
 * public, unauthenticated address that a calendar polls on a timer — it is not raised here. What was
 * missing is the disclosure: an account holding more dated open tasks than the ceiling handed its
 * subscriber a partial calendar that looked complete, so the reader's calendar quietly believed they had
 * nothing else due. The document now states the fact at calendar level when it arrives holding the
 * ceiling's worth of events, in the description clients show and in a numeric property beside it.
 *
 * The chain is pinned end to end rather than only the renderer, because the disclosure is only true as
 * long as the read's `LIMIT` and the document's ceiling are the same shared number.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { MAX_TASKS_PER_QUERY } from '../src/shared/todos/model'
import { buildIcsCalendar, type IcsCalendarOptions, type IcsTask } from '../src/worker/todos/ics'
import { loadFeedTasks } from '../src/worker/todos/feeds'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'
import type { Env } from '../src/worker/env'

const USER = '0123456789abcdefghjkmncapp'
const DAY = 24 * 60 * 60 * 1000
const HORIZON = Date.parse('2026-03-01T00:00:00Z')

function options(overrides: Partial<IcsCalendarOptions> = {}): IcsCalendarOptions {
  return { now: HORIZON, timezone: 'UTC', horizonMs: 90 * DAY, ...overrides }
}

/** One dated open task, due `index` hours after the horizon so ordering is the read's own. */
function task(index: number): IcsTask {
  return {
    id: `task-${String(index).padStart(4, '0')}`,
    title: `Task ${index}`,
    description: '',
    priority: 'medium',
    dueAt: HORIZON + index * 60 * 60 * 1000,
    repeat: null,
  }
}

function tasks(count: number): IcsTask[] {
  return Array.from({ length: count }, (_, index) => task(index + 1))
}

/** Unfold the document the way a client would, so assertions read the logical property lines. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean)
}

function property(ics: string, name: string): string[] {
  return unfold(ics).filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1))
}

let sqlite: DatabaseSync
let env: Env

/** Open, dated rows written straight to the table, past the ceiling the feed read carries. */
function seedTasks(count: number): void {
  const insert = sqlite.prepare(
    `INSERT INTO todos_tasks (user_id, id, title, status, due_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'todo', ?4, ?5, ?5)`,
  )
  for (let index = 1; index <= count; index += 1) {
    insert.run(USER, `task-${String(index).padStart(4, '0')}`, `Task ${index}`, HORIZON + index * 3_600_000, 1)
  }
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA journal_mode = OFF')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  env = testBindings(makeD1(sqlite), {})
})

describe('the document a capped read returns', () => {
  it('stays silent while it holds fewer tasks than the ceiling', () => {
    const ics = buildIcsCalendar(tasks(MAX_TASKS_PER_QUERY - 1), options())

    expect(property(ics, 'X-WR-CALDESC')).toEqual([])
    expect(property(ics, 'X-INKSTONE-FEED-LIMIT')).toEqual([])
  })

  it('discloses the ceiling the moment it holds as many events as the read may carry', () => {
    const ics = buildIcsCalendar(tasks(MAX_TASKS_PER_QUERY), options())

    expect(property(ics, 'X-INKSTONE-FEED-LIMIT')).toEqual([String(MAX_TASKS_PER_QUERY)])
    const [description] = property(ics, 'X-WR-CALDESC')
    expect(description).toBeDefined()
    expect(description!.replace(/\\,/g, ',')).toContain(`at most ${MAX_TASKS_PER_QUERY} open tasks`)
    expect(description!.replace(/\\,/g, ',')).toContain(`this document holds ${MAX_TASKS_PER_QUERY} of them`)
  })

  it('prints the number the caller named, not a hardcoded one, so the two halves cannot drift', () => {
    const ics = buildIcsCalendar(tasks(3), options({ taskLimit: 3 }))

    expect(property(ics, 'X-INKSTONE-FEED-LIMIT')).toEqual(['3'])
    expect(property(ics, 'X-WR-CALDESC').join(' ')).toContain('at most 3 open tasks')
  })

  it('keeps the notice above the first event and the document valid', () => {
    const ics = buildIcsCalendar(tasks(MAX_TASKS_PER_QUERY), options())
    const lines = unfold(ics)

    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines.indexOf('METHOD:PUBLISH')).toBeLessThan(lines.findIndex((line) => line === 'BEGIN:VEVENT'))
    expect(lines.findIndex((line) => line.startsWith('X-WR-CALDESC:'))).toBeGreaterThan(lines.indexOf('METHOD:PUBLISH'))
    expect(lines.at(-1)).toBe('END:VCALENDAR')
  })
})

describe('the read and the document agree', () => {
  it('caps the account at the ceiling the feed query binds, and the renderer knows it', async () => {
    seedTasks(MAX_TASKS_PER_QUERY + 25)

    const rows = await loadFeedTasks(env.DB as D1Database, USER, HORIZON + 90 * DAY)
    expect(rows).toHaveLength(MAX_TASKS_PER_QUERY)

    // What the route does with them, with the ceiling left at its default.
    const ics = buildIcsCalendar(rows, { now: HORIZON, timezone: 'UTC', horizonMs: 90 * DAY })

    expect(property(ics, 'X-INKSTONE-FEED-LIMIT')).toEqual([String(MAX_TASKS_PER_QUERY)])
    expect(property(ics, 'SUMMARY')).toHaveLength(MAX_TASKS_PER_QUERY)
    expect(property(ics, 'X-WR-CALDESC').join(' ')).toContain('partial view of the account')
  })

  it('says nothing for an account the ceiling has not reached', async () => {
    seedTasks(4)

    const rows = await loadFeedTasks(env.DB as D1Database, USER, HORIZON + 90 * DAY)
    expect(rows).toHaveLength(4)

    const ics = buildIcsCalendar(rows, { now: HORIZON, timezone: 'UTC', horizonMs: 90 * DAY })

    expect(property(ics, 'X-WR-CALDESC')).toEqual([])
    expect(property(ics, 'SUMMARY')).toHaveLength(4)
  })
})

describe('the ceiling stays where the audit found it', () => {
  // A public address that reads an account's table on every poll is a denial-of-service handle, so the
  // bound is kept and disclosed rather than raised. Pinned as a number because the disclosure prints it
  // and a reader is meant to be able to check the sentence against the calendar.
  it('is the shared per-query bound, not a number this module invented', () => {
    expect(MAX_TASKS_PER_QUERY).toBe(500)
  })

  it('never lets an account hand a subscriber more events than the bound', async () => {
    seedTasks(MAX_TASKS_PER_QUERY + 25)

    expect(await loadFeedTasks(env.DB as D1Database, USER, HORIZON + 90 * DAY)).toHaveLength(MAX_TASKS_PER_QUERY)
  })
})

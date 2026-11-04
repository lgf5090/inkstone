// @vitest-environment node
/**
 * The calendar tools the assistant reaches through the executor.
 *
 * The real `CalendarStore` runs against an in-memory D1 double, because the point of these tools is
 * that a sentence becomes a stored row: a fake calendar would pass while nothing was written. The
 * cases pin the defaults the model depends on — the default calendar, the account's zone, one hour
 * for an unspecified meeting — and the two safety rules: a range filters real rows, and a delete is a
 * pending action rather than a write.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantConversation } from '../src/shared/assistant'
import { defaultCalendarPreferences, temporalValueToEpochMs } from '../src/shared/calendar/model'
import { initializeDatabase } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { ToolExecutor, runApprovedAction, type ToolContext } from '../src/worker/assistant/tools'
import { CalendarStore } from '../src/worker/calendar/store'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'
import { testBindings } from './doubles/bindings'

const USER = '0123456789abcdefghjkmnpqrs'
const ZONE = 'Asia/Shanghai'
/**
 * The turn's clock is pinned to the first minute of 4 November 2026 in the account zone. The cases
 * below are written against a fixed day, so they must not inherit the hour the suite happens to run
 * at: at 10:31 the "first free slot" of that day is no longer 10:30.
 */
const NOW = Date.parse('2026-11-03T16:00:00Z')
const DAY_END = Date.parse('2026-11-04T16:00:00Z')

let sqlite: DatabaseSync
let env: Env
let assistant: AssistantStore
let conversation: AssistantConversation
let calendar: CalendarStore
let defaultCalendarId: string

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    store: assistant,
    env,
    ftsEnabled: false,
    origin: 'http://localhost',
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, timezone: ZONE },
    timezone: ZONE,
    dayEnd: DAY_END,
    now: NOW,
    mode: 'chat',
    conversationId: conversation.id,
    memoryHistory: {} as ToolContext['memoryHistory'],
    memoryScope: { projectId: null },
    automations: {} as ToolContext['automations'],
    noteScope: async () => ({ restricted: false, folderIds: new Set(), tagIds: new Set(), noteIds: new Set() }),
    writeContext: {} as ToolContext['writeContext'],
    ...over,
  }
}

function executor(ctx: ToolContext = context()): ToolExecutor {
  return new ToolExecutor(ctx, { maxToolCalls: 20 })
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  env = testBindings(makeD1(sqlite))
  await initializeDatabase(env)
  assistant = new AssistantStore(env.DB, USER, env)
  conversation = await assistant.createConversation('Calendar bench')
  calendar = new CalendarStore(env.DB, USER)
  await calendar.savePreferences({ ...defaultCalendarPreferences(), timeZone: ZONE })
  const [created] = await calendar.ensureDefaultCalendar()
  defaultCalendarId = created!.id
})

describe('creating an event', () => {
  it('files it in the default calendar, in the account zone, for one hour by default', async () => {
    const result = await executor().execute('calendar_create_event', {
      title: '和张三开会',
      start: '2026-11-04T15:00',
    }, 'call-create') as { created: boolean, event: Record<string, unknown> }

    expect(result.created).toBe(true)
    expect(result.event).toMatchObject({
      title: '和张三开会',
      start: '2026-11-04T15:00',
      end: '2026-11-04T16:00',
      calendar_ids: [defaultCalendarId],
      time_zone: ZONE,
    })

    const stored = await calendar.getEvent(String(result.event.id))
    expect(stored).not.toBeNull()
    expect(temporalValueToEpochMs(stored!.start, ZONE)).toBe(Date.parse('2026-11-04T07:00:00Z'))
    expect(temporalValueToEpochMs(stored!.end, ZONE) - temporalValueToEpochMs(stored!.start, ZONE))
      .toBe(60 * 60_000)
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(USER))
      .toMatchObject({ count: 1 })
  })
})

describe('listing a range', () => {
  beforeEach(async () => {
    await executor().execute('calendar_create_event', { title: '周会', start: '2026-11-04T09:00' }, 'seed-a')
    await executor().execute('calendar_create_event', { title: '评审', start: '2026-11-10T14:00' }, 'seed-b')
  })

  it('returns only the events inside the asked-for day', async () => {
    const oneDay = await executor().execute('calendar_list_events', {
      from: '2026-11-04',
      to: '2026-11-04',
    }, 'list-day') as { events: Array<{ title: string }>, time_zone: string }
    expect(oneDay.events.map((event) => event.title)).toEqual(['周会'])
    expect(oneDay.time_zone).toBe(ZONE)
  })

  it('returns both when the range covers the week', async () => {
    const week = await executor().execute('calendar_list_events', {
      from: '2026-11-04',
      to: '2026-11-10',
    }, 'list-week') as { events: Array<{ title: string }> }
    expect(week.events.map((event) => event.title)).toEqual(['周会', '评审'])
  })
})

describe('moving an event', () => {
  it('keeps its length when only the start changes', async () => {
    const created = await executor().execute('calendar_create_event', {
      title: '评审',
      start: '2026-11-05T15:00',
      end: '2026-11-05T16:00',
    }, 'create-review') as { event: { id: string } }

    const moved = await executor().execute('calendar_move_event', {
      id: created.event.id,
      start: '2026-11-09T10:00',
    }, 'move-review') as { moved: boolean, event: Record<string, unknown> }

    expect(moved.moved).toBe(true)
    expect(moved.event).toMatchObject({ start: '2026-11-09T10:00', end: '2026-11-09T11:00' })
    const stored = await calendar.getEvent(created.event.id)
    expect(stored).not.toBeNull()
    expect(temporalValueToEpochMs(stored!.start, ZONE)).toBe(Date.parse('2026-11-09T02:00:00Z'))
    expect(temporalValueToEpochMs(stored!.end, ZONE) - temporalValueToEpochMs(stored!.start, ZONE))
      .toBe(60 * 60_000)
  })
})

describe('finding a slot', () => {
  it('answers with a real gap that misses the stored busy block', async () => {
    await executor().execute('calendar_create_event', {
      title: '占用',
      start: '2026-11-04T09:00',
      end: '2026-11-04T10:30',
    }, 'create-busy')

    const answer = await executor().execute('calendar_find_slot', {
      from: '2026-11-04',
      to: '2026-11-04',
      days: '3',
      durationMinutes: 90,
      limit: 3,
    }, 'find-slot') as { slots: Array<{ start: string, end: string, start_ms: number, end_ms: number }>, note?: string }

    expect(answer.slots.length).toBeGreaterThan(0)
    expect(answer.slots[0]).toMatchObject({ start: '2026-11-04T10:30', end: '2026-11-04T12:00' })
    const busyStart = Date.parse('2026-11-04T01:00:00Z')
    const busyEnd = Date.parse('2026-11-04T02:30:00Z')
    for (const slot of answer.slots) {
      expect(slot.start_ms < busyEnd && slot.end_ms > busyStart).toBe(false)
    }
  })

  it('rolls to the next allowed day once today\'s window has closed', async () => {
    // 11:00 UTC on 4 November is 19:00 in Shanghai, an hour after the default window ends.
    const late = context({ now: Date.parse('2026-11-04T11:00:00Z') })
    const answer = await executor(late).execute('calendar_find_slot', {
      from: '2026-11-04',
      to: '2026-11-05',
      days: '3,4',
      durationMinutes: 60,
      limit: 1,
    }, 'find-late') as { slots: Array<{ start: string, end: string, start_ms: number, end_ms: number }> }

    expect(answer.slots).toHaveLength(1)
    expect(answer.slots[0]).toMatchObject({
      start: '2026-11-05T09:00',
      end: '2026-11-05T10:00',
      start_ms: Date.parse('2026-11-05T01:00:00Z'),
    })
  })

  it('lets a slot run to midnight when the window ends at 24', async () => {
    const answer = await executor().execute('calendar_find_slot', {
      from: '2026-11-04',
      to: '2026-11-04',
      dayStartHour: 20,
      dayEndHour: 24,
      durationMinutes: 240,
      limit: 1,
    }, 'find-midnight') as { slots: Array<{ start: string, end: string, start_ms: number, end_ms: number, day: string }> }

    expect(answer.slots).toHaveLength(1)
    expect(answer.slots[0]).toMatchObject({
      start: '2026-11-04T20:00',
      end: '2026-11-05T00:00',
      start_ms: Date.parse('2026-11-04T12:00:00Z'),
      end_ms: Date.parse('2026-11-04T16:00:00Z'),
      day: '2026-11-04',
    })
  })

  it('keeps the wall-clock window in a half-hour zone', async () => {
    await calendar.savePreferences({ ...defaultCalendarPreferences(), timeZone: 'Asia/Kolkata' })
    await executor().execute('calendar_create_event', {
      title: '占用',
      start: '2026-11-04T09:00',
      end: '2026-11-04T10:30',
    }, 'create-busy-kolkata')

    const answer = await executor().execute('calendar_find_slot', {
      from: '2026-11-04',
      to: '2026-11-04',
      days: '3',
      durationMinutes: 90,
      limit: 1,
    }, 'find-kolkata') as { slots: Array<{ start: string, end: string, start_ms: number }>, time_zone: string }

    // 10:30 IST is 05:00 UTC, not 04:30 or 05:30: the +05:30 offset is not rounded to whole hours.
    expect(answer.time_zone).toBe('Asia/Kolkata')
    expect(answer.slots[0]).toMatchObject({
      start: '2026-11-04T10:30',
      end: '2026-11-04T12:00',
      start_ms: Date.parse('2026-11-04T05:00:00Z'),
    })
  })

  it('keeps the wall-clock window across the DST changeover days', async () => {
    await calendar.savePreferences({ ...defaultCalendarPreferences(), timeZone: 'America/New_York' })
    // 31 October 2026 noon in New York: the day before the clocks fall back from 02:00 to 01:00.
    const eve = context({ now: Date.parse('2026-10-31T16:00:00Z') })
    const fallBack = await executor(eve).execute('calendar_find_slot', {
      from: '2026-11-01',
      to: '2026-11-01',
      days: '0',
      durationMinutes: 60,
      limit: 1,
    }, 'find-fall-back') as { slots: Array<{ start: string, end: string, start_ms: number, end_ms: number }> }

    // 09:00 EST is 14:00 UTC; an elapsed-hour add from midnight would have answered 08:00 EST.
    expect(fallBack.slots[0]).toMatchObject({
      start: '2026-11-01T09:00',
      end: '2026-11-01T10:00',
      start_ms: Date.parse('2026-11-01T14:00:00Z'),
      end_ms: Date.parse('2026-11-01T15:00:00Z'),
    })

    const lateFallBack = await executor(eve).execute('calendar_find_slot', {
      from: '2026-11-01',
      to: '2026-11-01',
      days: '0',
      dayStartHour: 20,
      dayEndHour: 24,
      durationMinutes: 240,
      limit: 1,
    }, 'find-fall-back-midnight') as { slots: Array<{ start: string, end: string, end_ms: number }> }

    // 24:00 is the end of that 25-hour calendar day, so the slot still ends at next-day midnight.
    expect(lateFallBack.slots[0]).toMatchObject({
      start: '2026-11-01T20:00',
      end: '2026-11-02T00:00',
      end_ms: Date.parse('2026-11-02T05:00:00Z'),
    })

    // 7 March 2026 noon in New York: the day before the clocks spring forward from 02:00 to 03:00.
    const spring = context({ now: Date.parse('2026-03-07T17:00:00Z') })
    const springForward = await executor(spring).execute('calendar_find_slot', {
      from: '2026-03-08',
      to: '2026-03-08',
      days: '0',
      durationMinutes: 60,
      limit: 1,
    }, 'find-spring-forward') as { slots: Array<{ start: string, start_ms: number }> }

    // 09:00 EDT is 13:00 UTC; an elapsed-hour add from midnight would have answered 10:00 EDT.
    expect(springForward.slots[0]).toMatchObject({
      start: '2026-03-08T09:00',
      start_ms: Date.parse('2026-03-08T13:00:00Z'),
    })
  })
})

describe('deleting an event', () => {
  it('raises an approval card and leaves the row in place until it is approved', async () => {
    const created = await executor().execute('calendar_create_event', {
      title: '旧项目同步',
      start: '2026-11-06T15:00',
    }, 'create-sync') as { event: { id: string } }

    const proposal = await executor().execute('calendar_delete_event', {
      id: created.event.id,
    }, 'delete-sync') as { status: string, action: string }

    expect(proposal.status).toBe('awaiting_reader_approval')
    expect(proposal.action).toContain('旧项目同步')
    expect(proposal.action).toContain('2026-11-06T15:00')
    expect(await calendar.getEvent(created.event.id)).not.toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(USER))
      .toMatchObject({ count: 1 })

    const actions = await assistant.actionStatesForConversation(conversation.id)
    const pending = [...actions.values()].find((action) => action.tool === 'calendar_delete_event')
    expect(pending).toBeDefined()
    expect(pending!.status).toBe('pending')
    expect(pending!.targetLabel).toContain('旧项目同步')

    await runApprovedAction(assistant, context(), pending!.id)
    expect(await calendar.getEvent(created.event.id)).toBeNull()
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?').get(USER))
      .toMatchObject({ count: 0 })
  })
})

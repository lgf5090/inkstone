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
    dayEnd: 1_700_000_000_000,
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

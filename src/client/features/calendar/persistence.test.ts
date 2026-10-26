import { Temporal } from 'temporal-polyfill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, EventChange, ICalendarApp } from '@dayflow/react'
import type { CalendarEventDto, CalendarEventInput } from '../../../shared/calendar/model'
import { ApiError } from '../../lib/api'
import { EventPersistence } from './persistence'
import type { CalendarEditHistory } from './history'
import * as api from './api'

vi.mock('./api', () => ({
  createEvent: vi.fn(),
  createEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
}))

function event(title: string): Event {
  return {
    id: 'evt-1',
    title,
    start: Temporal.ZonedDateTime.from('2026-10-26T09:00:00+00:00[UTC]'),
    end: Temporal.ZonedDateTime.from('2026-10-26T10:00:00+00:00[UTC]'),
    allDay: false,
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
    meta: {},
  }
}

function fakeApp(): { app: ICalendarApp; emit: (change: EventChange) => void; applied: Array<{ changes: unknown; source?: string }> } {
  const listeners = new Set<(changes: EventChange[]) => void>()
  const applied: Array<{ changes: unknown; source?: string }> = []
  const app = {
    subscribeEventChanges: (callback: (changes: EventChange[]) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    canMutateFromUI: () => true,
    applyEventsChanges: (changes: unknown, _snapshot: boolean, source?: string) => {
      applied.push({ changes, source })
    },
  } as unknown as ICalendarApp
  return {
    app,
    emit: change => { for (const listener of listeners) listener([change]) },
    applied,
  }
}

describe('event persistence rollback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(api.updateEvent).mockReset()
    vi.mocked(api.createEvent).mockReset()
    vi.mocked(api.deleteEvent).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores the server-confirmed shape when a write is refused', async () => {
    const fake = fakeApp()
    const onError = vi.fn()
    const record = vi.fn()
    const persistence = new EventPersistence({
      app: fake.app,
      revs: new Map([['evt-1', 1]]),
      history: { record } as unknown as CalendarEditHistory,
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState: vi.fn(),
      onError,
      onConflict: vi.fn(),
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
    })
    persistence.start()
    vi.mocked(api.updateEvent).mockRejectedValue(new ApiError(403, 'forbidden', 'read only'))

    fake.emit({ type: 'update', before: event('Original'), after: event('Edited'), source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(record).not.toHaveBeenCalled()
    expect(fake.applied).toHaveLength(1)
    expect(fake.applied[0]?.source).toBe('local')
    expect(fake.applied[0]?.changes).toMatchObject({
      update: [{ id: 'evt-1', updates: { title: 'Original' } }],
    })
    persistence.dispose()
  })

  it('announces a committed edit to a recurring series', async () => {
    const fake = fakeApp()
    const onCommitted = vi.fn()
    const persistence = new EventPersistence({
      app: fake.app,
      revs: new Map([['evt-1', 1]]),
      history: { record: vi.fn() } as unknown as CalendarEditHistory,
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState: vi.fn(),
      onError: vi.fn(),
      onConflict: vi.fn(),
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
      onCommitted,
    })
    persistence.start()
    vi.mocked(api.updateEvent).mockResolvedValue({ rev: 2 } as never)
    const before = { ...event('Weekly'), meta: { recurrenceRule: 'FREQ=WEEKLY' } }
    const after = { ...event('Weekly edited'), meta: { recurrenceRule: 'FREQ=WEEKLY' } }

    fake.emit({ type: 'update', before, after, source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onCommitted).toHaveBeenCalledWith('evt-1', true)
    persistence.dispose()
  })

  it('removes a created event that the server never accepted', async () => {
    const fake = fakeApp()
    const onError = vi.fn()
    const persistence = new EventPersistence({
      app: fake.app,
      revs: new Map(),
      history: { record: vi.fn() } as unknown as CalendarEditHistory,
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState: vi.fn(),
      onError,
      onConflict: vi.fn(),
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
    })
    persistence.start()
    vi.mocked(api.createEvent).mockRejectedValue(new ApiError(500, 'internal', 'failed'))

    fake.emit({ type: 'create', event: event('New'), source: 'local' })
    await vi.advanceTimersByTimeAsync(200)
    await vi.advanceTimersByTimeAsync(600)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(fake.applied[0]?.changes).toMatchObject({ delete: ['evt-1'] })
    persistence.dispose()
  })
})

describe('write conflicts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(api.updateEvent).mockReset()
    vi.mocked(api.createEvent).mockReset()
    vi.mocked(api.deleteEvent).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const merged: CalendarEventInput = {
    title: 'Merged',
    start: { value: '2026-10-26T09:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
    end: { value: '2026-10-26T10:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
  }

  function serverDto(rev: number): CalendarEventDto {    return {
      id: 'evt-1',
      title: 'Merged',
      description: '',
      kind: 'event',
      task: null,
      conference: null,
      start: merged.start!,
      end: merged.end!,
      allDay: false,
      calendarId: 'cal-1',
      calendarIds: ['cal-1'],
      meta: {},
      icon: null,
      recurrenceRule: null,
      rev,
      source: 'local',
      externalId: null,
    }
  }

  function setup() {
    const fake = fakeApp()
    const onConflict = vi.fn()
    const onServerState = vi.fn()
    const onError = vi.fn()
    const record = vi.fn()
    const revs = new Map([['evt-1', 1]])
    const persistence = new EventPersistence({
      app: fake.app,
      revs,
      history: { record } as unknown as CalendarEditHistory,
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState,
      onError,
      onConflict,
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
    })
    persistence.start()
    return { fake, onConflict, onServerState, onError, record, revs, persistence }
  }

  async function conflictWhileSavingEdit(
    context: ReturnType<typeof setup>,
    revision = 7,
  ): Promise<void> {
    vi.mocked(api.updateEvent).mockRejectedValueOnce(new ApiError(409, 'conflict', 'stale revision'))
    vi.mocked(api.updateEvent).mockResolvedValue(serverDto(revision) as never)
    context.fake.emit({ type: 'update', before: event('Original'), after: event('Edited'), source: 'local' })
    await vi.advanceTimersByTimeAsync(200)
  }

  it('asks the reader to choose instead of dropping the edit', async () => {
    const context = setup()
    await conflictWhileSavingEdit(context)

    expect(context.onConflict).toHaveBeenCalledTimes(1)
    const request = context.onConflict.mock.calls[0]![0]
    expect(request).toMatchObject({ id: 'evt-1', intent: 'save' })
    expect(request.mine.title).toBe('Edited')
    expect(context.onServerState).not.toHaveBeenCalled()
    expect(context.fake.applied).toHaveLength(0)
    expect(context.persistence.hasPending('evt-1')).toBe(true)
    context.persistence.dispose()
  })

  it('writes the merged event with the revision the server reported', async () => {
    const context = setup()
    await conflictWhileSavingEdit(context)

    await context.persistence.resolveConflict('evt-1', { action: 'save', input: merged, rev: 4 })

    expect(api.updateEvent).toHaveBeenLastCalledWith('evt-1', merged, 4)
    expect(context.revs.get('evt-1')).toBe(7)
    expect(context.onServerState).toHaveBeenCalledWith('evt-1')
    expect(context.persistence.hasPending('evt-1')).toBe(false)
    context.persistence.dispose()
  })

  it('loads the server copy when the reader discards their changes', async () => {
    const context = setup()
    await conflictWhileSavingEdit(context)

    await context.persistence.resolveConflict('evt-1', { action: 'server' })

    expect(api.updateEvent).toHaveBeenCalledTimes(1)
    expect(context.onServerState).toHaveBeenCalledWith('evt-1')
    expect(context.fake.applied).toHaveLength(0)
    expect(context.record).not.toHaveBeenCalled()
    context.persistence.dispose()
  })

  it('stops asking about an event whose merge was refused too', async () => {
    const context = setup()
    await conflictWhileSavingEdit(context)
    vi.mocked(api.updateEvent).mockRejectedValue(new ApiError(409, 'conflict', 'still stale'))

    await context.persistence.resolveConflict('evt-1', { action: 'save', input: merged, rev: 4 })

    expect(context.onConflict).toHaveBeenCalledTimes(1)
    expect(context.onError).toHaveBeenCalledTimes(1)
    expect(context.onServerState).toHaveBeenCalledWith('evt-1')
    context.persistence.dispose()
  })

  it('deletes with the fresh revision when the reader insists', async () => {
    const context = setup()
    vi.mocked(api.deleteEvent).mockRejectedValueOnce(new ApiError(409, 'conflict', 'stale revision'))
    vi.mocked(api.deleteEvent).mockResolvedValue(undefined as never)
    context.fake.emit({ type: 'delete', event: event('Original'), source: 'local' })
    await vi.advanceTimersByTimeAsync(200)

    expect(context.onConflict.mock.calls[0]![0]).toMatchObject({ id: 'evt-1', intent: 'delete', mine: null })

    await context.persistence.resolveConflict('evt-1', { action: 'delete', rev: 9 })

    expect(api.deleteEvent).toHaveBeenLastCalledWith('evt-1', 9)
    expect(context.revs.has('evt-1')).toBe(false)
    expect(context.record).toHaveBeenCalledTimes(1)
    context.persistence.dispose()
  })

  it('ignores a decision for an event it has already forgotten', async () => {
    const context = setup()
    await conflictWhileSavingEdit(context)
    await context.persistence.resolveConflict('evt-1', { action: 'server' })

    await context.persistence.resolveConflict('evt-1', { action: 'server' })

    expect(context.onServerState).toHaveBeenCalledTimes(1)
    context.persistence.dispose()
  })
})

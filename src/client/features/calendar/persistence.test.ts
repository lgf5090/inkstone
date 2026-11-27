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

function fakeHistory(record = vi.fn()): CalendarEditHistory {
  return {
    record,
    finishReplay: vi.fn(),
    failReplay: vi.fn(),
    remapReplay: vi.fn(),
  } as unknown as CalendarEditHistory
}

function serverEventDto(rev: number, overrides: Partial<CalendarEventDto> = {}): CalendarEventDto {
  return {
    id: 'evt-1',
    title: 'New',
    description: '',
    kind: 'event',
    task: null,
    conference: null,
    start: { value: '2026-10-26T09:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
    end: { value: '2026-10-26T10:00:00+00:00[UTC]', type: 'zoned', timeZone: 'UTC' },
    allDay: false,
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
    meta: {},
    icon: null,
    color: null,
    recurrenceRule: null,
    recurrenceParentId: null,
    recurrenceId: null,
    recurrenceCancelled: false,
    rev,
    source: 'local',
    externalId: null,
    ...overrides,
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

  it('restores the server-confirmed shape and hidden series rule when a write is refused', async () => {
    const fake = fakeApp()
    const onError = vi.fn()
    const record = vi.fn()
    const history = fakeHistory(record)
    const persistence = new EventPersistence({
      app: fake.app,
      revs: new Map([['evt-1', 1]]),
      history,
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
    const before = {
      ...event('Original'),
      meta: { exdates: ['2026-10-27T09:00:00Z'], seriesRule: 'FREQ=DAILY;COUNT=8' },
    }
    const after = { ...before, title: 'Edited', meta: { exdates: ['2026-10-28T09:00:00Z'] } }

    fake.emit({ type: 'update', before, after, source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(history.failReplay)).toHaveBeenCalledWith('evt-1')
    expect(record).not.toHaveBeenCalled()
    expect(fake.applied[0]?.changes).toMatchObject({
      update: [{
        id: 'evt-1',
        updates: { title: 'Original', meta: { exdates: ['2026-10-27T09:00:00Z'], seriesRule: 'FREQ=DAILY;COUNT=8' } },
      }],
    })
    persistence.dispose()
  })

  it('announces a committed edit to a recurring series', async () => {
    const fake = fakeApp()
    const onCommitted = vi.fn()
    const persistence = new EventPersistence({
      app: fake.app,
      revs: new Map([['evt-1', 1]]),
      history: fakeHistory(),
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
      history: fakeHistory(),
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

  it('adopts the id a shared calendar answers with, so the next edit reaches that row', async () => {
    const fake = fakeApp()
    const revs = new Map<string, number>()
    const persistence = new EventPersistence({
      app: fake.app,
      revs,
      history: fakeHistory(),
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState: vi.fn(),
      onError: vi.fn(),
      onConflict: vi.fn(),
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
    })
    persistence.start()
    const sharedId = 'shared:owner-1:evt-1'
    vi.mocked(api.createEvent).mockResolvedValue(serverEventDto(4, { id: sharedId }) as never)
    vi.mocked(api.updateEvent).mockResolvedValue(serverEventDto(5, { id: sharedId, title: 'Edited' }) as never)

    fake.emit({ type: 'create', event: event('New'), source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(revs.has('evt-1')).toBe(false)
    expect(revs.get(sharedId)).toBe(4)
    expect(fake.applied[0]?.changes).toMatchObject({ delete: ['evt-1'], add: [{ id: sharedId }] })

    // The app echoes the repaint it was handed; the skip entries eat those two, not the reader's edit.
    fake.emit({ type: 'delete', event: { ...event('New'), id: 'evt-1' }, source: 'remote' })
    fake.emit({ type: 'create', event: { ...event('New'), id: sharedId }, source: 'remote' })

    fake.emit({
      type: 'update',
      before: { ...event('New'), id: sharedId },
      after: { ...event('Edited'), id: sharedId },
      source: 'local',
    })
    await vi.advanceTimersByTimeAsync(300)

    expect(api.updateEvent).toHaveBeenCalledWith(sharedId, expect.anything(), 4)
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
      color: null,
      recurrenceRule: null,
      recurrenceParentId: null,
      recurrenceId: null,
      recurrenceCancelled: false,
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
    const history = fakeHistory(record)
    const revs = new Map([['evt-1', 1]])
    const persistence = new EventPersistence({
      app: fake.app,
      revs,
      history,
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState,
      onError,
      onConflict,
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
    })
    persistence.start()
    return { fake, onConflict, onServerState, onError, record, history, revs, persistence }
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
    expect(vi.mocked(context.history.failReplay)).toHaveBeenCalledWith('evt-1')
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

  it('opens conflict handling when the retry receives a stale revision', async () => {
    const context = setup()
    vi.mocked(api.updateEvent)
      .mockRejectedValueOnce(new ApiError(500, 'internal', 'temporary'))
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'stale revision'))
    context.fake.emit({ type: 'update', before: event('Original'), after: event('Edited'), source: 'local' })
    await vi.advanceTimersByTimeAsync(900)

    expect(context.onConflict).toHaveBeenCalledTimes(1)
    expect(context.onError).not.toHaveBeenCalled()
    expect(context.fake.applied).toHaveLength(0)
    context.persistence.dispose()
  })

  it('adopts an outbox conflict so the existing dialog can resolve it', async () => {
    const context = setup()
    const request = { id: 'evt-1', intent: 'save' as const, mine: merged }
    context.persistence.acceptConflict(request)
    expect(context.persistence.hasPending('evt-1')).toBe(true)
    vi.mocked(api.updateEvent).mockResolvedValue(serverDto(8) as never)

    await context.persistence.resolveConflict('evt-1', { action: 'save', input: merged, rev: 6 })

    expect(api.updateEvent).toHaveBeenCalledWith('evt-1', merged, 6)
    expect(context.revs.get('evt-1')).toBe(8)
    expect(context.persistence.hasPending('evt-1')).toBe(false)
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

describe('occurrence edits and offline writes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(api.updateEvent).mockReset()
    vi.mocked(api.createEvent).mockReset()
    vi.mocked(api.deleteEvent).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function options(fake: ReturnType<typeof fakeApp>, overrides: Record<string, unknown>) {
    return {
      app: fake.app,
      revs: new Map([['master', 2]]),
      history: fakeHistory(),
      timeZone: () => 'UTC',
      fallbackTitle: () => 'Untitled',
      onServerState: vi.fn(),
      onError: vi.fn(),
      onConflict: vi.fn(),
      onRecurringEdit: vi.fn(),
      onReadOnlyEdit: vi.fn(),
      ...overrides,
    }
  }

  it('hands an occurrence edit to the scope dialog after reverting it', async () => {
    const fake = fakeApp()
    const onRecurrenceOccurrence = vi.fn()
    const before = { ...event('Occurrence'), id: 'master::repeat-1' }
    const after = { ...before, title: 'Changed occurrence' }
    const persistence = new EventPersistence(options(fake, { onRecurrenceOccurrence }))
    persistence.start()
    fake.emit({ type: 'update', before, after, source: 'local' })
    await vi.advanceTimersByTimeAsync(300)
    expect(api.updateEvent).not.toHaveBeenCalled()
    expect(onRecurrenceOccurrence).toHaveBeenCalledTimes(1)
    expect(onRecurrenceOccurrence.mock.calls[0]?.[0]).toMatchObject({
      masterId: 'master',
      intent: 'save',
      after: { title: 'Changed occurrence' },
    })
    expect(fake.applied[0]?.source).toBe('local')
    persistence.dispose()
  })

  it('keeps an optimistic row and queues the write when the network is gone', async () => {
    const fake = fakeApp()
    const onOffline = vi.fn()
    vi.mocked(api.updateEvent).mockRejectedValue(new ApiError(0, 'offline', 'network down'))
    const persistence = new EventPersistence(options(fake, { onOffline, revs: new Map([['evt-1', 1]]) }))
    persistence.start()
    fake.emit({ type: 'update', before: event('Original'), after: event('Queued'), source: 'local' })
    await vi.advanceTimersByTimeAsync(900)
    expect(onOffline).toHaveBeenCalledTimes(1)
    expect(onOffline.mock.calls[0]?.[0]).toMatchObject({ kind: 'save', eventId: 'evt-1', baseRev: 1 })
    expect(fake.applied).toHaveLength(0)
    persistence.dispose()
  })

  it('rolls back and records no history when durable queueing fails', async () => {
    const fake = fakeApp()
    const onOffline = vi.fn(async () => false)
    const record = vi.fn()
    vi.mocked(api.updateEvent).mockRejectedValue(new ApiError(0, 'offline', 'network down'))
    const persistence = new EventPersistence(options(fake, {
      onOffline,
      history: fakeHistory(record),
      revs: new Map([['evt-1', 1]]),
    }))
    persistence.start()

    fake.emit({ type: 'update', before: event('Original'), after: event('Queued'), source: 'local' })
    await vi.advanceTimersByTimeAsync(900)

    expect(onOffline).toHaveBeenCalledWith(expect.objectContaining({ kind: 'save', baseRev: 1 }))
    expect(record).not.toHaveBeenCalled()
    expect(fake.applied[0]?.changes).toMatchObject({ update: [{ id: 'evt-1', updates: { title: 'Original' } }] })
    persistence.dispose()
  })

  it('records a null base revision for a newly created offline event', async () => {
    const fake = fakeApp()
    const onOffline = vi.fn(async () => true)
    vi.mocked(api.createEvent).mockRejectedValue(new ApiError(0, 'offline', 'network down'))
    const persistence = new EventPersistence(options(fake, { onOffline, revs: new Map() }))
    persistence.start()

    fake.emit({ type: 'create', event: event('New'), source: 'local' })
    await vi.advanceTimersByTimeAsync(900)

    expect(onOffline).toHaveBeenCalledWith(expect.objectContaining({ kind: 'save', eventId: 'evt-1', baseRev: null }))
    persistence.dispose()
  })

  it('cancels a queued offline create when the new event is deleted', async () => {
    const fake = fakeApp()
    const onOffline = vi.fn(async () => true)
    vi.mocked(api.createEvent).mockRejectedValue(new ApiError(0, 'offline', 'network down'))
    const persistence = new EventPersistence(options(fake, { onOffline, revs: new Map() }))
    persistence.start()
    const created = event('New')

    fake.emit({ type: 'create', event: created, source: 'local' })
    await vi.advanceTimersByTimeAsync(900)
    fake.emit({ type: 'delete', event: created, source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onOffline).toHaveBeenLastCalledWith({ kind: 'delete', eventId: 'evt-1', rev: null })
    expect(api.deleteEvent).not.toHaveBeenCalled()
    persistence.dispose()
  })

  it('keeps a deleted event visible when cancelling its queued create fails', async () => {
    const fake = fakeApp()
    const onOffline = vi.fn(async () => false)
    const persistence = new EventPersistence(options(fake, { onOffline, revs: new Map() }))
    persistence.start()
    const created = event('New')

    fake.emit({ type: 'create', event: created, source: 'local' })
    fake.emit({ type: 'delete', event: created, source: 'local' })
    await vi.advanceTimersByTimeAsync(300)

    expect(onOffline).toHaveBeenCalledWith({ kind: 'delete', eventId: 'evt-1', rev: null })
    expect(fake.applied[0]?.changes).toMatchObject({ add: [{ id: 'evt-1', title: 'New' }] })
    persistence.dispose()
  })
})

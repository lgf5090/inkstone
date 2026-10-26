import { Temporal } from 'temporal-polyfill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event, EventChange, ICalendarApp } from '@dayflow/react'
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

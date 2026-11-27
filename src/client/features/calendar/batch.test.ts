import { Temporal } from 'temporal-polyfill'
import type { Event } from '@dayflow/react'
import { describe, expect, it } from 'vitest'
import { batchColorUpdates, batchMoveUpdates } from './batch'

function event(id: string, start: string, end: string, allDay = false): Event {
  return {
    id,
    title: id,
    start: allDay ? Temporal.PlainDate.from(start) : Temporal.ZonedDateTime.from(start),
    end: allDay ? Temporal.PlainDate.from(end) : Temporal.ZonedDateTime.from(end),
    allDay,
    calendarId: 'cal-1',
    calendarIds: ['cal-1'],
    meta: {},
  }
}

describe('calendar batch updates', () => {
  it('moves timed events by the same elapsed duration and keeps their zones and lengths', () => {
    const events = [
      event('a', '2026-11-27T09:00:00+08:00[Asia/Shanghai]', '2026-11-27T10:00:00+08:00[Asia/Shanghai]'),
      event('b', '2026-11-27T20:00:00-05:00[America/New_York]', '2026-11-27T21:30:00-05:00[America/New_York]'),
    ]
    const updates = batchMoveUpdates(events, '2026-11-28', '11:00', 'Asia/Shanghai')
    expect(updates[0]?.updates.start?.toString()).toBe('2026-11-28T11:00:00+08:00[Asia/Shanghai]')
    expect(updates[1]?.updates.start?.toString()).toBe('2026-11-28T22:00:00-05:00[America/New_York]')
    expect(updates[1]?.updates.end?.toString()).toBe('2026-11-28T23:30:00-05:00[America/New_York]')
  })

  it('moves all-day rows by local calendar days and refuses mixed selections', () => {
    const allDay = [
      event('a', '2026-11-27', '2026-11-28', true),
      event('b', '2026-11-30', '2026-12-01', true),
    ]
    expect(batchMoveUpdates(allDay, '2026-12-02', '00:00', 'UTC').map(update => update.updates.start?.toString()))
      .toEqual(['2026-12-02', '2026-12-05'])
    expect(() => batchMoveUpdates([allDay[0]!, event('c', '2026-11-27T09:00:00+00:00[UTC]', '2026-11-27T10:00:00+00:00[UTC]')], '2026-12-02', '00:00', 'UTC'))
      .toThrow('mixed')
  })

  it('sets one colour without dropping existing metadata', () => {
    const original = { ...event('a', '2026-11-27T09:00:00+00:00[UTC]', '2026-11-27T10:00:00+00:00[UTC]'), meta: { location: 'Room' } }
    expect(batchColorUpdates([original], '#e5484d')[0]?.updates.meta).toEqual({ location: 'Room', color: '#e5484d' })
  })
})

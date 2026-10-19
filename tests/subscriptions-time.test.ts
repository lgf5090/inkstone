import { describe, expect, it } from 'vitest'
import {
  addCalendarPeriodInTimezone,
  daysInMonth,
  formatLocalDate,
  getDaysBetween,
  getNowInTimezone,
  getTimezoneDateParts,
  getTimezoneMidnightTimestamp,
  isValidTimezone,
  localHourKey,
  parseDateInputInTimezone,
} from '../src/shared/subscriptions/time'

const SHANGHAI = 'Asia/Shanghai'

describe('time zones', () => {
  it('reads calendar fields in the zone rather than the host clock', () => {
    const parts = getTimezoneDateParts('2026-05-24T15:30:00Z', SHANGHAI)
    expect(parts).toEqual({ year: 2026, month: 5, day: 24, hour: 23, minute: 30, second: 0 })
  })

  it('falls back to UTC for a zone that does not exist', () => {
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
    const parts = getTimezoneDateParts('2026-05-24T15:30:00Z', 'Mars/Olympus')
    expect(parts.hour).toBe(15)
  })

  it('counts whole days between local midnights', () => {
    expect(getDaysBetween('2026-05-24T20:00:00Z', '2026-05-24T22:00:00Z', SHANGHAI)).toBe(0)
    expect(getDaysBetween('2026-05-24T15:00:00Z', '2026-05-24T16:00:00Z', SHANGHAI)).toBe(1)
    expect(getDaysBetween('2026-05-24T16:00:00Z', '2026-05-24T15:00:00Z', SHANGHAI)).toBe(-1)
  })

  it('counts calendar days across a daylight-saving change', () => {
    expect(getDaysBetween('2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z', 'America/New_York')).toBe(2)
  })

  it('finds the instant of the zone midnight', () => {
    expect(getTimezoneMidnightTimestamp('2026-05-24T15:30:00Z', SHANGHAI)).toBe(Date.UTC(2026, 4, 23, 16, 0, 0))
    expect(getTimezoneMidnightTimestamp('2026-05-24T15:30:00Z', 'UTC')).toBe(Date.UTC(2026, 4, 24, 0, 0, 0))
  })

  it('reads a bare date as midnight in the reader zone', () => {
    expect(parseDateInputInTimezone('2026-05-24', SHANGHAI).getTime()).toBe(Date.UTC(2026, 4, 23, 16, 0, 0))
    expect(parseDateInputInTimezone('2026-05-24T00:00:00Z', SHANGHAI).getTime()).toBe(Date.UTC(2026, 4, 24, 0, 0, 0))
  })
})

describe('calendar arithmetic', () => {
  it('clamps to the last day of a shorter month', () => {
    const january = Date.UTC(2026, 0, 31, 0, 0, 0)
    const february = addCalendarPeriodInTimezone(january, 1, 'month', 'UTC')
    expect(february.toISOString().slice(0, 10)).toBe('2026-02-28')
    expect(daysInMonth(2024, 2)).toBe(29)
  })

  it('adds a year without drifting off the leap day', () => {
    const leap = Date.UTC(2024, 1, 29, 0, 0, 0)
    expect(addCalendarPeriodInTimezone(leap, 1, 'year', 'UTC').toISOString().slice(0, 10)).toBe('2025-02-28')
  })

  it('adds days in the zone, not in UTC', () => {
    const start = Date.UTC(2026, 4, 23, 16, 0, 0)
    const next = addCalendarPeriodInTimezone(start, 1, 'day', SHANGHAI)
    expect(next.getTime()).toBe(Date.UTC(2026, 4, 24, 16, 0, 0))
  })
})

describe('formatting', () => {
  it('writes the same date shape in either language', () => {
    expect(formatLocalDate('2026-05-24T15:30:00Z', SHANGHAI, 'date')).toBe('2026-05-24')
    expect(formatLocalDate('2026-05-24T15:30:00Z', SHANGHAI, 'datetime')).toBe('2026-05-24 23:30:00')
    expect(formatLocalDate('2026-05-24T15:30:00Z', SHANGHAI, 'full')).toBe('2026-05-24 23:30')
  })

  it('builds the dedupe key from the local hour', () => {
    expect(localHourKey(SHANGHAI, new Date('2026-05-24T00:30:00Z'))).toBe('2026052408')
    expect(localHourKey('UTC', new Date('2026-05-24T00:30:00Z'))).toBe('2026052400')
  })

  it('reports the hour a schedule compares against the notification window', () => {
    expect(getNowInTimezone(SHANGHAI, new Date('2026-05-24T00:30:00Z')).hourString).toBe('08')
  })
})

import { describe, expect, it } from 'vitest'
import {
  PROJECT_ONE_DAY_MS,
  moveProjectDateValue,
  parseProjectDateValue,
  projectCalendarRangeToValue,
  projectDayToStamp,
  projectInputToStamp,
  projectStampToDay,
  projectStampToInput,
  projectValueToCalendarRange,
} from './date'

describe('the date picker round trip (§6.6)', () => {
  it('keeps the picked day across a DST boundary in any zone', () => {
    // 2026-03-08 is the US spring-forward day; local noon minus the offset must still read back as the 8th.
    const day = new Date(2026, 2, 8)
    const stamp = projectDayToStamp(day)
    expect(projectStampToInput(stamp)).toBe('2026-03-08')
    expect(projectStampToDay(stamp).getDate()).toBe(8)
  })

  it('stores UTC noon, not local midnight', () => {
    const stamp = projectDayToStamp(new Date(2026, 10, 15))
    expect(new Date(stamp).getUTCHours()).toBe(12)
    expect(new Date(stamp).getUTCMinutes()).toBe(0)
  })

  it('skips both zone shifts for an includeTime value', () => {
    const stamp = projectDayToStamp(new Date(2026, 10, 15), true)
    expect(stamp).toBe(new Date(2026, 10, 15, 12, 0, 0, 0).getTime())
    expect(projectStampToDay(stamp, true).getDate()).toBe(15)
    expect(projectStampToInput(stamp, true)).toBe('2026-11-15')
  })

  it('reads and writes the yyyy-mm-dd input shape', () => {
    const stamp = projectInputToStamp('2026-11-15')
    expect(stamp).not.toBeNull()
    expect(projectStampToInput(stamp!)).toBe('2026-11-15')
    expect(projectInputToStamp('')).toBeNull()
    expect(projectInputToStamp('15/11/2026')).toBeNull()
    expect(projectInputToStamp('2026-02-30')).toBeNull()
  })
})

describe('the stored value shapes', () => {
  it('parses the JSON envelope and the bare millisecond string alike', () => {
    expect(parseProjectDateValue('{"from":1000,"to":2000}')).toEqual({ from: 1000, to: 2000, includeTime: false, timeZone: undefined })
    expect(parseProjectDateValue('1000')).toEqual({ from: 1000 })
    expect(parseProjectDateValue('{"includeTime":true,"from":5}')).toEqual({ from: 5, to: undefined, includeTime: true, timeZone: undefined })
  })

  it('rejects empty, malformed and endpoint-less values', () => {
    expect(parseProjectDateValue('')).toBeNull()
    expect(parseProjectDateValue('   ')).toBeNull()
    expect(parseProjectDateValue('{oops')).toBeNull()
    expect(parseProjectDateValue('{"includeTime":true}')).toBeNull()
    expect(parseProjectDateValue('not a date')).toBeNull()
    expect(parseProjectDateValue('null')).toBeNull()
  })
})

describe('the calendar range (§6.6)', () => {
  it('drops a day from the exclusive end and omits `to` for a single day', () => {
    const start = new Date(2026, 10, 15)
    const value = projectCalendarRangeToValue(start, new Date(2026, 10, 16))
    expect(value.to).toBeUndefined()
    expect(projectStampToInput(value.from!)).toBe('2026-11-15')
  })

  it('keeps both endpoints for a multi-day range', () => {
    const value = projectCalendarRangeToValue(new Date(2026, 10, 15), new Date(2026, 10, 20))
    expect(projectStampToInput(value.from!)).toBe('2026-11-15')
    expect(projectStampToInput(value.to!)).toBe('2026-11-19')
  })

  it('reads a single-day value as a one-day exclusive range', () => {
    const from = projectDayToStamp(new Date(2026, 10, 15))
    const range = projectValueToCalendarRange({ from })
    expect(range).not.toBeNull()
    expect(range!.end.getTime() - range!.start.getTime()).toBe(PROJECT_ONE_DAY_MS)
    expect(projectValueToCalendarRange({})).toBeNull()
  })

  it('round trips a range through the grid and back', () => {
    const value = projectCalendarRangeToValue(new Date(2026, 10, 15), new Date(2026, 10, 20))
    const range = projectValueToCalendarRange(value)!
    expect(projectCalendarRangeToValue(range.start, range.end)).toEqual(value)
  })
})
describe('moving a value to a new start day', () => {
  it('carries `to` the same distance so the range keeps its length', () => {
    const from = projectDayToStamp(new Date(2026, 10, 10))
    const to = projectDayToStamp(new Date(2026, 10, 13))
    const next = projectDayToStamp(new Date(2026, 10, 15))
    const moved = moveProjectDateValue({ from, to }, next)
    expect(moved.from).toBe(next)
    expect(projectStampToInput(moved.to!)).toBe('2026-11-18')
    expect(moved.to! - moved.from!).toBe(to - from)
  })

  it('moves a range backwards as well as forwards', () => {
    const from = projectDayToStamp(new Date(2026, 10, 10))
    const to = projectDayToStamp(new Date(2026, 10, 13))
    const moved = moveProjectDateValue({ from, to }, projectDayToStamp(new Date(2026, 10, 5)))
    expect(projectStampToInput(moved.from!)).toBe('2026-11-05')
    expect(projectStampToInput(moved.to!)).toBe('2026-11-08')
  })

  it('adds no `to` when the value had none', () => {
    const moved = moveProjectDateValue({ from: projectDayToStamp(new Date(2026, 10, 10)) }, projectDayToStamp(new Date(2026, 10, 15)))
    expect(moved.to).toBeUndefined()
    expect(Object.keys(moved)).toEqual(['from'])
  })

  it('takes the new start alone when the old value had no start', () => {
    const next = projectDayToStamp(new Date(2026, 10, 15))
    expect(moveProjectDateValue({}, next)).toEqual({ from: next })
    expect(moveProjectDateValue({ to: 1000 }, next)).toEqual({ from: next, to: 1000 })
  })

  it('carries includeTime and timeZone, which choose the conversion every reader applies', () => {
    const moved = moveProjectDateValue({ from: 1000, to: 2000, includeTime: true, timeZone: 'Asia/Shanghai' }, 5000)
    expect(moved).toEqual({ from: 5000, to: 6000, includeTime: true, timeZone: 'Asia/Shanghai' })
    expect(moveProjectDateValue({ from: 1000, includeTime: false }, 5000)).toEqual({ from: 5000 })
  })
})

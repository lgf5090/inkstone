import { describe, expect, it } from 'vitest'
import type { TemporalValue } from '@shared/calendar/model'
import { temporalValueToEpochMs } from '@shared/calendar/model'
import { addWallMinutes, eventTimeZone, reanchorValue, shiftTemporalValue, supportedTimeZones, wallClockInZone } from './timezone'

const zoned = (value: string, timeZone: string): TemporalValue => ({ value, type: 'zoned', timeZone })

describe('reanchorValue', () => {
  it('keeps the wall clock and moves the instant', () => {
    const before = zoned('2027-06-03T14:00:00+00:00[UTC]', 'UTC')
    const after = reanchorValue(before, 'Asia/Shanghai')

    expect(after.type).toBe('zoned')
    expect(after.value).toBe('2027-06-03T14:00:00+08:00[Asia/Shanghai]')
    expect(temporalValueToEpochMs(after, 'UTC')).toBe(
      temporalValueToEpochMs(before, 'UTC') - 8 * 60 * 60_000,
    )
  })

  it('turns a floating value into a zoned one in the chosen zone', () => {
    const after = reanchorValue({ value: '2027-06-03T14:00:00', type: 'datetime' }, 'Europe/Berlin')

    expect(after).toEqual({
      value: '2027-06-03T14:00:00+02:00[Europe/Berlin]',
      type: 'zoned',
      timeZone: 'Europe/Berlin',
    })
  })

  it('leaves a whole day alone, because a date has no zone', () => {
    const date: TemporalValue = { value: '2027-06-03', type: 'date' }
    expect(reanchorValue(date, 'Asia/Shanghai')).toBe(date)
  })

  it('survives a wall clock the target zone skips', () => {
    // 2026-03-08 02:30 does not exist in New York; the value has to come back valid, not throw.
    const after = reanchorValue(zoned('2026-03-08T02:30:00+00:00[UTC]', 'UTC'), 'America/New_York')

    expect(after.type).toBe('zoned')
    expect(after.timeZone).toBe('America/New_York')
    // Temporal shifts a skipped wall clock forward by the gap: 02:30 becomes 03:30 EDT.
    expect(after.value).toBe('2026-03-08T03:30:00-04:00[America/New_York]')
    expect(temporalValueToEpochMs(after, 'UTC')).toBe(Date.parse('2026-03-08T07:30:00Z'))
  })

  it('round-trips back to the zone it came from', () => {
    const before = zoned('2027-01-15T09:30:00+09:00[Asia/Tokyo]', 'Asia/Tokyo')
    const there = reanchorValue(before, 'America/Los_Angeles')

    expect(reanchorValue(there, 'Asia/Tokyo')).toEqual(before)
  })
})

describe('eventTimeZone', () => {
  it('reads the zone off the value and falls back for a floating one', () => {
    expect(eventTimeZone(zoned('2027-06-03T14:00:00+08:00[Asia/Shanghai]', 'Asia/Shanghai'), 'UTC'))
      .toBe('Asia/Shanghai')
    expect(eventTimeZone({ value: '2027-06-03T14:00:00', type: 'datetime' }, 'Europe/Kyiv'))
      .toBe('Europe/Kyiv')
    expect(eventTimeZone({ value: '2027-06-03', type: 'date' }, 'UTC')).toBeNull()
  })
})

describe('supportedTimeZones', () => {
  it('offers a sorted list the pickers can render', () => {
    const zones = supportedTimeZones()
    expect(zones.length).toBeGreaterThan(100)
    expect(zones).toContain('Asia/Shanghai')
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones)
  })
})

describe('wall clock helpers', () => {
  it('reads a grid instant in the account zone rather than the browser zone', () => {
    const instant = new Date('2026-11-08T05:30:00Z')
    expect(wallClockInZone(instant, 'Asia/Shanghai')).toEqual({ date: '2026-11-08', time: '13:30' })
    expect(wallClockInZone(instant, 'America/New_York')).toEqual({ date: '2026-11-08', time: '00:30' })
  })

  it('adds wall minutes across a DST change', () => {
    // 01:30 EST plus 60 minutes lands on 03:30 EDT, the wall clock New York actually shows.
    expect(addWallMinutes('2026-03-08', '01:30', 60, 'America/New_York')).toBe('2026-03-08T03:30')
  })

  it('shifts a zoned value by whole days and keeps its wall clock', () => {
    const moved = shiftTemporalValue(zoned('2027-06-03T14:00:00+08:00[Asia/Shanghai]', 'Asia/Shanghai'), 1)
    expect(moved.value).toBe('2027-06-04T14:00:00+08:00[Asia/Shanghai]')
    expect(moved.type).toBe('zoned')
  })

  it('shifts whole days and floating values too', () => {
    expect(shiftTemporalValue({ value: '2027-06-03', type: 'date' }, 1)).toEqual({ value: '2027-06-04', type: 'date' })
    expect(shiftTemporalValue({ value: '2027-06-03T09:30:00', type: 'datetime' }, 2)).toEqual({
      value: '2027-06-05T09:30:00',
      type: 'datetime',
    })
  })
})

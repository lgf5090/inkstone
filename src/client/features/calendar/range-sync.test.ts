import { describe, expect, it } from 'vitest'
import { CALENDAR_RANGE_MAX_MS } from '@shared/calendar/model'
import { RANGE_PADDING_DAYS } from './model'
import {
  canProbeRangeRevision,
  nextRevisionProbeCount,
  paddedCalendarRange,
  rangeIsCovered,
} from './range-sync'

const DAY_MS = 24 * 60 * 60 * 1000

describe('calendar range synchronization helpers', () => {
  it('recognises only intervals that completely cover the requested range', () => {
    const loaded: Array<[number, number]> = [[100, 200], [300, 500]]
    expect(rangeIsCovered(loaded, 120, 180)).toBe(true)
    expect(rangeIsCovered(loaded, 300, 500)).toBe(true)
    expect(rangeIsCovered(loaded, 90, 150)).toBe(false)
    expect(rangeIsCovered(loaded, 150, 250)).toBe(false)
    expect(rangeIsCovered(loaded, 501, 600)).toBe(false)
  })

  it('pads both sides of a visible period', () => {
    const start = Date.UTC(2026, 10, 1)
    const end = Date.UTC(2026, 10, 7)
    expect(paddedCalendarRange(start, end)).toEqual({
      from: start - RANGE_PADDING_DAYS * DAY_MS,
      to: end + RANGE_PADDING_DAYS * DAY_MS,
    })
  })

  it('centres an oversized visible period inside the server range limit', () => {
    const start = Date.UTC(2026, 0, 1)
    const end = start + CALENDAR_RANGE_MAX_MS * 2
    const range = paddedCalendarRange(start, end)
    expect(range.to - range.from).toBe(CALENDAR_RANGE_MAX_MS)
    expect((range.from + range.to) / 2).toBe((start + end) / 2)
  })

  it('allows four fingerprint probes before forcing a full read', () => {
    expect([0, 1, 2, 3].map(canProbeRangeRevision)).toEqual([true, true, true, true])
    expect(canProbeRangeRevision(4)).toBe(false)
    expect(nextRevisionProbeCount(3, true)).toBe(4)
    expect(nextRevisionProbeCount(4, true)).toBe(0)
  })

  it('counts only unchanged probes and resets after the full-read backstop', () => {
    expect(nextRevisionProbeCount(0, false)).toBe(0)
    expect(nextRevisionProbeCount(1, true)).toBe(2)
    expect(nextRevisionProbeCount(2, false)).toBe(2)
    expect(nextRevisionProbeCount(4, false)).toBe(0)
  })
})

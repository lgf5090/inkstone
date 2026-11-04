/**
 * A date-only answer is a calendar day, not an instant.
 *
 * The old path fed `Date.parse('2026-11-04')` (UTC midnight) into a local `setHours`, so a reader
 * west of Greenwich got the previous day in `{{DATE}}` and in journal titles.
 */
import { describe, expect, it } from 'vitest'
import { parseDayAnswer } from './session'

describe('parseDayAnswer', () => {
  it('reads a date-only answer as local midnight', () => {
    const day = parseDayAnswer('2026-11-04')!
    expect(day.getFullYear()).toBe(2026)
    expect(day.getMonth()).toBe(10)
    expect(day.getDate()).toBe(4)
    expect(day.getHours()).toBe(0)
    expect(day.getTime()).toBe(new Date(2026, 10, 4).getTime())
  })

  it('rejects a day the calendar does not have', () => {
    expect(parseDayAnswer('2026-02-30')).toBeNull()
  })

  it('keeps an explicit time or offset', () => {
    const day = parseDayAnswer('2026-11-04T10:00:00Z')!
    expect(day.toISOString()).toBe('2026-11-04T10:00:00.000Z')
  })

  it('rejects text that names no day', () => {
    expect(parseDayAnswer('not a date')).toBeNull()
  })
})

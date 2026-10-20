/**
 * Price windows: what a stored schedule means, and which one a timestamp falls into.
 *
 * The two facts that are easy to get wrong live here: an overnight window belongs to the weekday it
 * started on, and the clock is the assistant's timezone rather than UTC or the browser's.
 */
import { describe, expect, it } from 'vitest'
import { activePricePeriod, parsePricePeriods } from '../src/shared/price-periods'

function period(over: Record<string, unknown> = {}) {
  return {
    id: 'peak',
    label: 'Peak',
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:00',
    inputPrice: 2,
    outputPrice: 4,
    ...over,
  }
}

describe('stored price windows', () => {
  it('reads valid windows, sorts weekdays and keeps their ids', () => {
    const [saved] = parsePricePeriods([period({ days: [5, 1, 3, 3] })])
    expect(saved).toEqual({
      id: 'peak', label: 'Peak', days: [1, 3, 5], start: '09:00', end: '12:00', inputPrice: 2, outputPrice: 4,
    })
  })

  it('leaves out windows that cannot be judged instead of failing the model', () => {
    expect(parsePricePeriods([
      period({ id: 'same', start: '09:00', end: '09:00' }),
      period({ id: 'missing', start: '09:00', end: '' }),
      period({ id: 'bad-hour', start: '24:00', end: '25:00' }),
      period({ id: 'ok' }),
    ])).toEqual([{
      id: 'ok', label: 'Peak', days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00', inputPrice: 2, outputPrice: 4,
    }])
  })

  it('gives a window a stable handle when the file has none, and never reuses one', () => {
    const parsed = parsePricePeriods([period({ id: undefined }), period({ id: 'p1' })])
    expect(parsed.map((entry) => entry.id)).toHaveLength(2)
    expect(new Set(parsed.map((entry) => entry.id)).size).toBe(2)
  })
})

describe('which window is in force', () => {
  it('matches a weekday window in the assistant timezone', () => {
    const periods = parsePricePeriods([period()])
    expect(activePricePeriod(periods, new Date('2026-10-20T09:30:00Z'), 'UTC')?.id).toBe('peak')
    expect(activePricePeriod(periods, new Date('2026-10-20T12:00:00Z'), 'UTC')).toBeNull()
    expect(activePricePeriod(periods, new Date('2026-10-20T01:00:00Z'), 'Asia/Shanghai')?.id).toBe('peak')
    expect(activePricePeriod(periods, new Date('2026-10-20T01:00:00Z'), 'UTC')).toBeNull()
    expect(activePricePeriod(periods, new Date('2026-10-24T10:00:00Z'), 'UTC')).toBeNull()
  })

  it('keeps the after-midnight half of an overnight window on its starting weekday', () => {
    const periods = parsePricePeriods([period({ start: '22:00', end: '02:00' })])
    // 2026-10-19 is a Monday; 01:00 on Tuesday belongs to Monday night.
    expect(activePricePeriod(periods, new Date('2026-10-19T23:00:00Z'), 'UTC')?.id).toBe('peak')
    expect(activePricePeriod(periods, new Date('2026-10-20T01:00:00Z'), 'UTC')?.id).toBe('peak')
    // Saturday 01:00 is still Friday night, which is in the weekday set.
    expect(activePricePeriod(periods, new Date('2026-10-24T01:00:00Z'), 'UTC')?.id).toBe('peak')
    // Sunday night starts a new week, so Monday 01:00 is not in the window.
    expect(activePricePeriod(periods, new Date('2026-10-26T01:00:00Z'), 'UTC')).toBeNull()
  })

  it('reads no weekdays as every day, and takes the first of two overlapping windows', () => {
    const everyDay = parsePricePeriods([period({ id: 'always', days: [] })])
    expect(activePricePeriod(everyDay, new Date('2026-10-24T10:00:00Z'), 'UTC')?.id).toBe('always')
    const overlapping = parsePricePeriods([
      period({ id: 'first' }),
      period({ id: 'second', start: '10:00', end: '11:00' }),
    ])
    expect(activePricePeriod(overlapping, new Date('2026-10-20T10:30:00Z'), 'UTC')?.id).toBe('first')
  })
})

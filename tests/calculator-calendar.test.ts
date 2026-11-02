import { describe, expect, it } from 'vitest'
import {
  addDuration,
  calendarParts,
  difference,
  formatDate,
  subtractDuration,
} from '@shared/tools/calculator/converters/date-calculator'

describe('non-Gregorian calendar support', () => {
  it('reads Japanese era dates', () => {
    expect(calendarParts('2024-01-01', 'japanese')).toMatchObject({ year: 6, month: 1, day: 1 })
    expect(calendarParts('2019-04-30', 'japanese')?.year).toBe(31)
  })

  it('adds years across a Japanese era boundary', () => {
    expect(addDuration('2019-04-30', 1, 0, 0, 'japanese')).toBe('2020-04-30')
    expect(calendarParts('2020-04-30', 'japanese')?.year).toBe(2)
  })

  it('computes a Japanese calendar difference', () => {
    const result = difference('2019-01-01', '2024-01-01', 'japanese')
    expect(result?.years).toBe(5)
    expect(result?.months).toBe(0)
    expect(result?.days).toBe(0)
  })

  it('adds an Islamic Umm al-Qura month', () => {
    const start = calendarParts('2024-01-01', 'islamic-umalqura')
    expect(start).toMatchObject({ year: 1445, month: 6, day: 19 })
    const result = addDuration('2024-01-01', 0, 1, 0, 'islamic-umalqura')
    expect(result).not.toBeNull()
    expect(calendarParts(result!, 'islamic-umalqura')).toMatchObject({ year: 1445, month: 7, day: 19 })
    const differenceResult = difference('2024-01-01', result!, 'islamic-umalqura')
    expect(differenceResult?.months).toBe(1)
    expect(differenceResult?.days).toBe(0)
  })

  it('subtracts an Islamic Umm al-Qura month', () => {
    const result = subtractDuration('2024-03-01', 0, 1, 0, 'islamic-umalqura')
    expect(result).not.toBeNull()
    const parts = calendarParts(result!, 'islamic-umalqura')
    expect(parts).not.toBeNull()
  })

  it('formats dates in the selected calendar', () => {
    expect(formatDate('2024-01-01', 'en-US', 'islamic-umalqura')).toContain('1445')
    expect(formatDate('2024-01-01', 'en-US', 'japanese')).toContain('Reiwa')
  })
})

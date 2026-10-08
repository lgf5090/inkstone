import { describe, expect, it } from 'vitest'
import { firstDayOfWeek, formatDatePattern } from './date-pattern'

const date = (iso: string, hours = 13, minutes = 5, seconds = 9): Date => {
  const [day] = iso.split('T')
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  return new Date(year, month - 1, dayOfMonth, hours, minutes, seconds)
}

const OCT_8 = '2026-10-08'

describe('formatDatePattern', () => {
  it('renders the calendar fields an author actually writes', () => {
    const when = date(OCT_8)
    expect(formatDatePattern(when, 'YYYY-MM-DD', { locale: 'en-US' })).toBe('2026-10-08')
    expect(formatDatePattern(when, 'YY/M/D', { locale: 'en-US' })).toBe('26/10/8')
    expect(formatDatePattern(when, 'HH:mm:ss', { locale: 'en-US' })).toBe('13:05:09')
    expect(formatDatePattern(when, 'h:mm A', { locale: 'en-US' })).toBe('1:05 PM')
    expect(formatDatePattern(when, 'HH', { locale: 'en-US' })).toBe('13')
    expect(formatDatePattern(when, 'Q', { locale: 'en-US' })).toBe('4')
    expect(formatDatePattern(when, 'DDD', { locale: 'en-US' })).toBe('281')
  })

  it('numbers the ISO week the way the calendar does', () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026; 8 October is 40 weeks later.
    expect(formatDatePattern(date(OCT_8), 'GGGG-[W]WW', { locale: 'en-US' })).toBe('2026-W41')
    expect(formatDatePattern(date('2024-12-30'), 'GGGG-WW', { locale: 'en-US' })).toBe('2025-01')
    expect(formatDatePattern(date('2025-12-29'), 'GGGG-WW', { locale: 'en-US' })).toBe('2026-01')
    expect(formatDatePattern(date('2023-01-01'), 'GGGG-WW', { locale: 'en-US' })).toBe('2022-52')
    expect(formatDatePattern(date('2021-01-03'), 'GGGG-WW', { locale: 'en-US' })).toBe('2020-53')
    expect(formatDatePattern(date(OCT_8), 'W', { locale: 'en-US' })).toBe('41')
    expect(formatDatePattern(date(OCT_8), 'E', { locale: 'en-US' })).toBe('4')
  })

  it('names months and weekdays from the interface locale', () => {
    expect(formatDatePattern(date(OCT_8), 'MMM MMMM', { locale: 'en-US' })).toBe('Oct October')
    expect(formatDatePattern(date(OCT_8), 'dddd ddd', { locale: 'en-US' })).toBe('Thursday Thu')
    const zhCN = formatDatePattern(date(OCT_8), 'MMMM dddd', { locale: 'zh-CN' })
    expect(zhCN).toContain(new Intl.DateTimeFormat('zh-CN', { month: 'long' }).format(date(OCT_8)))
    expect(zhCN).toContain(new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date(OCT_8)))
  })

  it('counts the locale week from the locale’s own first weekday', () => {
    expect(formatDatePattern(date(OCT_8), 'ww', { locale: 'en-US' })).toBe('41')
    expect(formatDatePattern(date(OCT_8), 'ww', { locale: 'de-DE' })).toBe('41')
    expect(formatDatePattern(date('2026-01-01'), 'w', { locale: 'en-US' })).toBe('1')
    expect(formatDatePattern(date('2026-01-04'), 'w', { locale: 'en-US' })).toBe('2')
    expect(formatDatePattern(date('2026-01-04'), 'w', { locale: 'de-DE' })).toBe('1')
    expect(formatDatePattern(date('2024-12-30'), 'w', { locale: 'en-US' })).toBe('53')
  })

  it('keeps literal runs and backslash escapes out of the token table', () => {
    expect(formatDatePattern(date(OCT_8), 'YYYY[Q]Q', { locale: 'en-US' })).toBe('2026Q4')
    expect(formatDatePattern(date(OCT_8), '[DD]DD', { locale: 'en-US' })).toBe('DD08')
    expect(formatDatePattern(date(OCT_8), 'YYYY\\-MM', { locale: 'en-US' })).toBe('2026-10')
    // An unterminated literal keeps its bracket, the way Moment prints it: dropping the bracket
    // would silently turn an author's typo into a format token.
    expect(formatDatePattern(date(OCT_8), '[unterminated', { locale: 'en-US' })).toBe('[unterminated')
  })

  it('writes English ordinals and plain numbers elsewhere', () => {
    expect(formatDatePattern(date('2026-10-01'), 'Do', { locale: 'en-US' })).toBe('1st')
    expect(formatDatePattern(date(OCT_8), 'Do', { locale: 'en-US' })).toBe('8th')
    expect(formatDatePattern(date('2026-10-02'), 'Do', { locale: 'en-US' })).toBe('2nd')
    expect(formatDatePattern(date('2026-10-11'), 'Do', { locale: 'en-US' })).toBe('11th')
    expect(formatDatePattern(date('2026-10-22'), 'Do', { locale: 'en-US' })).toBe('22nd')
    expect(formatDatePattern(date(OCT_8), 'Do', { locale: 'de-DE' })).toBe('8')
  })

  it('prints a run it does not know instead of swallowing it', () => {
    expect(formatDatePattern(date(OCT_8), 'YYYY-zzz', { locale: 'en-US' })).toBe('2026-zzz')
    expect(formatDatePattern(date(OCT_8), 'YYYY-Q', { locale: 'en-US' })).toBe('2026-4')
    expect(formatDatePattern(date(OCT_8), 'YYYY[Q]Q', { locale: 'en-US' })).toBe('2026Q4')
    expect(formatDatePattern(date(OCT_8), 'YYYY-SSS', { locale: 'en-US' })).toBe('2026-000')
  })

  it('renders epochs and offsets from the machine, not from the pattern', () => {
    const when = date(OCT_8, 0, 0, 0)
    expect(formatDatePattern(when, 'x', { locale: 'en-US' })).toBe(String(when.getTime()))
    expect(formatDatePattern(when, 'X', { locale: 'en-US' })).toBe(String(Math.floor(when.getTime() / 1000)))
    expect(formatDatePattern(when, 'ZZ', { locale: 'en-US' })).toMatch(/^[+-]\d{4}$/)
  })

  it('answers the weekday questions the snap rules depend on', () => {
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('de-DE')).toBe(1)
    expect(firstDayOfWeek('not-a-tag')).toBe(0)
  })
})

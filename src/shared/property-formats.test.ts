import { describe, expect, it } from 'vitest'
import {
  durationToMs,
  formatDateString,
  formatDateStamp,
  formatDurationAbbreviated,
  formatDurationHuman,
  formatDurationStamp,
  isSupportedDateFormat,
  monthNamesFor,
} from './property-formats'

const MORNING = new Date(2026, 0, 5, 13, 4, 5, 120).getTime()
const SECOND = 1000

describe('formatDateStamp', () => {
  it('expands the calendar tokens a reader writes', () => {
    expect(formatDateStamp(MORNING, 'YYYY-MM-DD', 'en-US')).toBe('2026-01-05')
    expect(formatDateStamp(MORNING, 'YY/M/D', 'en-US')).toBe('26/1/5')
    expect(formatDateStamp(MORNING, 'DD.MM.YYYY', 'en-US')).toBe('05.01.2026')
    expect(formatDateStamp(MORNING, 'HH:mm:ss.SSS', 'en-US')).toBe('13:04:05.120')
    expect(formatDateStamp(MORNING, 'h:mm A', 'en-US')).toBe('1:04 PM')
    expect(formatDateStamp(MORNING, 'h:mm a', 'en-US')).toBe('1:04 pm')
  })

  it('names the month in the reader\'s language', () => {
    expect(formatDateStamp(MORNING, 'MMMM', 'en-US')).toBe('January')
    expect(formatDateStamp(MORNING, 'MMM', 'en-US')).toBe('Jan')
    expect(formatDateStamp(MORNING, 'MMMM', 'zh-CN')).toBe('\u4e00\u6708')
  })

  it('keeps what the brackets and the backslash quote', () => {
    expect(formatDateStamp(MORNING, '[day] D', 'en-US')).toBe('day 5')
    expect(formatDateStamp(MORNING, '\\D D', 'en-US')).toBe('D 5')
    expect(formatDateStamp(MORNING, 'D', 'en-US')).toBe('5')
  })

  it('answers an offset that matches the running zone', () => {
    expect(formatDateStamp(MORNING, 'ZZ', 'en-US')).toMatch(/^[+-]\d{4}$/)
    expect(formatDateStamp(MORNING, 'Z', 'en-US')).toMatch(/^[+-]\d{2}:\d{2}$/)
  })

  it('gives nothing back for a stamp or a pattern it cannot read', () => {
    expect(formatDateStamp(Number.NaN, 'YYYY', 'en-US')).toBe('')
    expect(formatDateStamp(MORNING, '', 'en-US')).toBe('')
  })

  it('refuses a pattern that is empty or absurdly long', () => {
    expect(isSupportedDateFormat('')).toBe(false)
    expect(isSupportedDateFormat('x'.repeat(121))).toBe(false)
    expect(isSupportedDateFormat('YYYY-MM')).toBe(true)
  })
})

describe('durationToMs', () => {
  it('reads the unit names the reference spells out', () => {
    expect(durationToMs(1, 's')).toBe(SECOND)
    expect(durationToMs(1, 'seconds')).toBe(SECOND)
    expect(durationToMs(2, 'minutes')).toBe(120_000)
    expect(durationToMs(1, 'h')).toBe(3_600_000)
    expect(durationToMs(1, 'days')).toBe(86_400_000)
    expect(durationToMs(1, 'w')).toBe(604_800_000)
    expect(durationToMs(1, 'fortnight')).toBe(null)
    expect(durationToMs(Number.NaN, 's')).toBe(null)
  })
})

describe('formatDurationStamp', () => {
  it('wraps past a day the way a clock face does', () => {
    expect(formatDurationStamp(829 * SECOND, 'HH:mm:ss')).toBe('00:13:49')
    expect(formatDurationStamp(829 * SECOND, 'mm:ss')).toBe('13:49')
    expect(formatDurationStamp(36 * 3_600_000 + 7 * 60_000, 'DD HH:mm')).toBe('01 12:07')
  })

  it('gives the whole amount when the token is bracketed', () => {
    expect(formatDurationStamp(829 * SECOND, '[ss]')).toBe('829')
    expect(formatDurationStamp(829 * SECOND, '[mm]')).toBe('13')
    expect(formatDurationStamp(36 * 3_600_000, '[HH]')).toBe('36')
    expect(formatDurationStamp(36 * 3_600_000, 'HH')).toBe('12')
  })

  it('passes through a pattern it has no token for', () => {
    expect(formatDurationStamp(829 * SECOND, 'about mm ss')).toBe('about 13 49')
  })
})

describe('formatDurationAbbreviated', () => {
  it('drops the units that are still zero', () => {
    expect(formatDurationAbbreviated(829 * SECOND)).toBe('13m 49s')
    expect(formatDurationAbbreviated(36 * 3_600_000)).toBe('1d 12h')
    expect(formatDurationAbbreviated(500)).toBe('500ms')
    expect(formatDurationAbbreviated(0)).toBe('0ms')
  })

  it('keeps every non-zero unit in the middle', () => {
    expect(formatDurationAbbreviated(2 * 31_536_000_000 + 3 * 604_800_000 + 90_000)).toBe('2y 3w 1m 30s')
  })
})

describe('formatDurationHuman', () => {
  it('speaks the largest unit that still counts', () => {
    expect(formatDurationHuman(829 * SECOND, 'plain', 'en-US')).toBe('14 minutes')
    expect(formatDurationHuman(829 * SECOND, 'relative', 'en-US')).toBe('in 14 minutes')
    expect(formatDurationHuman(-829 * SECOND, 'relative', 'en-US')).toBe('14 minutes ago')
    expect(formatDurationHuman(45 * SECOND, 'plain', 'en-US')).toBe('1 minute')
    expect(formatDurationHuman(30 * SECOND, 'plain', 'en-US')).toBe('30 seconds')
  })

  it('answers in the language the reader asked for', () => {
    expect(formatDurationHuman(829 * SECOND, 'plain', 'zh-CN')).toBe('14\u5206\u949f')
    expect(formatDurationHuman(-829 * SECOND, 'relative', 'zh-CN')).toBe('14\u5206\u949f\u524d')
  })
})

describe('monthNamesFor', () => {
  it('gives twelve names per style and caches the answer', () => {
    const english = monthNamesFor('en-US')
    expect(english.long).toHaveLength(12)
    expect(english.short[0]).toBe('Jan')
    expect(monthNamesFor('en-US')).toBe(english)
    expect(monthNamesFor('zh-CN').long[0]).toBe('\u4e00\u6708')
    expect(monthNamesFor('zh-CN').short[0]).toBe('1\u6708')
  })
})

describe('formatDateString', () => {
  it('reads a day key without dragging in a time', () => {
    expect(formatDateString('2026-01-05', 'YYYY/MM/DD', 'en-US')).toBe('2026/01/05')
    expect(formatDateString('nonsense', 'YYYY', 'en-US')).toBe('nonsense')
  })
})

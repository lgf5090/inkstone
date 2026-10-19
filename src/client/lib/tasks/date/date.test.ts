import { describe, expect, it } from 'vitest'
import { addUnits, dateKey } from '../../../lib/time'
import { DateRange, numberedDateRange } from './date-range'
import { parseDay, parseRange, expandDateAbbreviation } from './date-parser'
import { compareTaskDates, formatTaskDate, isInvalidTaskDate } from './date-tools'
import { canApplyFallback, fallbackDateFromPath, type FilenameDateSettings } from './date-fallback'

const MON_19_OCT_2026 = new Date(2026, 9, 19)

function range(input: string, now = MON_19_OCT_2026): string {
    const parsed = parseRange(input, now)
    return parsed === null ? 'null' : `${dateKey(parsed.start)}..${dateKey(parsed.end)}`
}

describe('DateRange', () => {
    it('normalises a reversed pair and strips both bounds to midnight', () => {
        const span = new DateRange(new Date(2026, 9, 30, 18, 30), new Date(2026, 9, 2, 7, 15))
        expect(dateKey(span.start)).toBe('2026-10-02')
        expect(dateKey(span.end)).toBe('2026-10-30')
        expect(span.start.getHours()).toBe(0)
        expect(span.end.getHours()).toBe(0)
    })

    it('keeps an unparseable span invalid instead of collapsing to a real day', () => {
        expect(DateRange.buildInvalid().isValid()).toBe(false)
        expect(new DateRange(new Date(Number.NaN), new Date(2026, 0, 1)).isValid()).toBe(false)
    })

    it('builds the four relative spans around a Monday in October', () => {
        expect(DateRange.buildRelative('week', MON_19_OCT_2026).describe()).toBe('2026-10-19 to 2026-10-25')
        expect(DateRange.buildRelative('month', MON_19_OCT_2026).describe()).toBe('2026-10-01 to 2026-10-31')
        expect(DateRange.buildRelative('quarter', MON_19_OCT_2026).describe()).toBe('2026-10-01 to 2026-12-31')
        expect(DateRange.buildRelative('year', MON_19_OCT_2026).describe()).toBe('2026-01-01 to 2026-12-31')
    })
})

describe('numberedDateRange', () => {
    it('reads a year, month, quarter and ISO week', () => {
        const show = (input: string): string => {
            const span = numberedDateRange(input)
            return span === null ? 'null' : `${dateKey(span.start)}..${dateKey(span.end)}`
        }
        expect(show('2026')).toBe('2026-01-01..2026-12-31')
        expect(show('2026-03')).toBe('2026-03-01..2026-03-31')
        expect(show('2026-Q2')).toBe('2026-04-01..2026-06-30')
        expect(show('2026-W10')).toBe('2026-03-02..2026-03-08')
        expect(show('2026-13')).toBe('null')
        expect(show('friday')).toBe('null')
    })

    it('opens ISO week 1 on the Monday of the row holding the first Thursday', () => {
        expect(dateKey(numberedDateRange('2026-W01')!.start)).toBe('2025-12-29')
        expect(dateKey(numberedDateRange('2024-W01')!.start)).toBe('2024-01-01')
    })
})

describe('parseDay', () => {
    it('answers local midnight so a whole day compares equal', () => {
        const parsed = parseDay('2026-10-21', MON_19_OCT_2026)
        expect(parsed === null ? null : dateKey(parsed)).toBe('2026-10-21')
        expect(parsed!.getHours()).toBe(0)
        expect(parsed!.getMinutes()).toBe(0)
    })

    it('keeps "friday" and "next friday" apart', () => {
        expect(dateKey(parseDay('friday', MON_19_OCT_2026, true)!)).toBe('2026-10-23')
        expect(dateKey(parseDay('next friday', MON_19_OCT_2026, true)!)).toBe('2026-10-30')
    })

    it('returns null rather than a sentinel when the text names no day', () => {
        expect(parseDay('sometime soon-ish', MON_19_OCT_2026)).toBeNull()
        expect(parseDay('', MON_19_OCT_2026)).toBeNull()
    })

    it('expands shorthands only ahead of a space', () => {
        expect(expandDateAbbreviation('td ').trim()).toBe('today')
        expect(expandDateAbbreviation('today')).toBe('today')
        expect(dateKey(parseDay('tm ', MON_19_OCT_2026)!)).toBe('2026-10-20')
    })
})

describe('parseRange', () => {
    it('steps relative spans by whole units', () => {
        expect(range('last month')).toBe('2026-09-01..2026-09-30')
        expect(range('next month')).toBe('2026-11-01..2026-11-30')
        expect(range('this week')).toBe('2026-10-19..2026-10-25')
        expect(range('last week')).toBe('2026-10-12..2026-10-18')
        expect(range('next quarter')).toBe('2027-01-01..2027-03-31')
        expect(range('last year')).toBe('2025-01-01..2025-12-31')
    })

    it('reads a pair of absolute dates and a single one', () => {
        expect(range('17 August 2013 19 August 2013')).toBe('2013-08-17..2013-08-19')
        expect(range('2026-10-21')).toBe('2026-10-21..2026-10-21')
    })

    it('returns null for text with no date in it', () => {
        expect(range('whenever')).toBe('null')
    })
})

describe('addUnits', () => {
    it('clamps a day the target month does not have, instead of overflowing into the next one', () => {
        expect(dateKey(addUnits(new Date(2026, 9, 31), -1, 'month'))).toBe('2026-09-30')
        expect(dateKey(addUnits(new Date(2026, 0, 31), 1, 'month'))).toBe('2026-02-28')
        expect(dateKey(addUnits(new Date(2024, 0, 31), 1, 'month'))).toBe('2024-02-29')
        expect(dateKey(addUnits(new Date(2024, 1, 29), 1, 'year'))).toBe('2025-02-28')
        expect(dateKey(addUnits(new Date(2026, 9, 31), -1, 'quarter'))).toBe('2026-07-31')
        expect(dateKey(addUnits(new Date(2026, 9, 19), 3, 'week'))).toBe('2026-11-09')
    })
})

describe('date-tools', () => {
    it('orders dated before undated and invalid before valid', () => {
        const valid = new Date(2026, 9, 1)
        const invalid = new Date(Number.NaN)
        expect(compareTaskDates(valid, null)).toBe(-1)
        expect(compareTaskDates(null, valid)).toBe(1)
        expect(compareTaskDates(null, null)).toBe(0)
        expect(compareTaskDates(invalid, valid)).toBe(-1)
        expect(compareTaskDates(valid, invalid)).toBe(1)
        expect(compareTaskDates(new Date(2026, 9, 1), new Date(2026, 9, 2))).toBe(-1)
        expect(compareTaskDates(valid, new Date(2026, 9, 1))).toBe(0)
    })

    it('formats only real days, and flags the shape that names no day', () => {
        expect(formatTaskDate(new Date(2026, 9, 5))).toBe('2026-10-05')
        expect(formatTaskDate(null)).toBe('')
        expect(formatTaskDate(new Date(Number.NaN))).toBe('')
        expect(isInvalidTaskDate(new Date(Number.NaN))).toBe(true)
        expect(isInvalidTaskDate(null)).toBe(false)
    })
})

describe('fallbackDateFromPath', () => {
    const on: FilenameDateSettings = { useFilenameAsScheduledDate: true, filenameAsScheduledDateFormat: '', filenameAsDateFolders: [] }

    function show(path: string, settings: FilenameDateSettings = on): string {
        const date = fallbackDateFromPath(path, settings)
        return date === null ? 'null' : dateKey(date)
    }

    it('stays silent unless the reader switched it on', () => {
        expect(show('notes/2026-10-19.md', { ...on, useFilenameAsScheduledDate: false })).toBe('null')
    })

    it('reads both journaling shapes out of the basename', () => {
        expect(show('journal/2026-10-19.md')).toBe('2026-10-19')
        expect(show('journal/20261019.md')).toBe('2026-10-19')
        expect(show('2026-10-19.md')).toBe('2026-10-19')
    })

    it('refuses a day that does not exist', () => {
        expect(show('journal/2026-02-30.md')).toBe('null')
        expect(show('journal/2026-13-01.md')).toBe('null')
    })

    it('honours the folder opt-in', () => {
        const scoped: FilenameDateSettings = { ...on, filenameAsDateFolders: ['journal'] }
        expect(show('journal/2026-10-19.md', scoped)).toBe('2026-10-19')
        expect(show('inbox/2026-10-19.md', scoped)).toBe('null')
    })

    it('uses a token pattern when it can read one back', () => {
        const dotted: FilenameDateSettings = { ...on, filenameAsScheduledDateFormat: 'YYYY_MM_DD' }
        expect(show('journal/2026_10_19.md', dotted)).toBe('2026-10-19')
        const unreadable: FilenameDateSettings = { ...on, filenameAsScheduledDateFormat: 'dddd' }
        expect(show('journal/2026-10-19.md', unreadable)).toBe('2026-10-19')
    })
})

describe('canApplyFallback', () => {
    it('applies only when the task states no date at all', () => {
        expect(canApplyFallback({ start: null, scheduled: null, due: null })).toBe(true)
        expect(canApplyFallback({ start: null, scheduled: null, due: new Date(2026, 9, 1) })).toBe(false)
    })
})

import { describe, expect, it } from 'vitest'
import { RRule } from 'rrule'
import * as chrono from 'chrono-node'

function day(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * Upstream seeds `dtstart` with a moment that has been moved to local midnight and then re-tagged as
 * UTC, so the rule iterates over calendar days rather than instants. Reproduced with plain Dates.
 */
function utcWallClockMidnight(local: Date): Date {
    return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

function isoDay(date: Date | null): string | null {
    return date === null ? null : date.toISOString().slice(0, 10)
}

describe('rrule contract', () => {
    it('parseText yields options, not a rule, and only becomes iterable once dtstart is set', () => {
        const options = RRule.parseText('every 4 weeks on Sunday')
        expect(options).not.toBeNull()
        expect(options).not.toBeInstanceOf(RRule)
        options!.dtstart = utcWallClockMidnight(new Date(2026, 9, 19))
        expect(new RRule(options!).toText()).toBe('every 4 weeks on Sunday')
    })

    it('after() is exclusive and nullable, so a dtstart that is itself an occurrence is skipped', () => {
        const options = RRule.parseText('every 4 weeks on Sunday')!
        options.dtstart = utcWallClockMidnight(new Date(2026, 9, 19))
        const rule = new RRule(options)
        expect(isoDay(rule.after(utcWallClockMidnight(new Date(2026, 9, 19))))).toBe('2026-10-25')
        const rebuilt = new RRule({ ...rule.origOptions, dtstart: utcWallClockMidnight(new Date(2026, 10, 1)) })
        expect(isoDay(rebuilt.after(utcWallClockMidnight(new Date(2026, 10, 1))))).toBe('2026-11-29')
        const boundedRule = new RRule({
            freq: RRule.DAILY,
            dtstart: utcWallClockMidnight(new Date(2026, 0, 1)),
            until: utcWallClockMidnight(new Date(2026, 0, 10)),
        })
        expect(isoDay(boundedRule.after(utcWallClockMidnight(new Date(2026, 0, 12))))).toBeNull()
    })

    it('iteration must be bounded, because an unbounded rule runs to the year 9999', () => {
        const options = RRule.parseText('every 4 weeks on Sunday')!
        options.dtstart = utcWallClockMidnight(new Date(2026, 9, 19))
        const rule = new RRule(options)
        const bounded = rule.between(utcWallClockMidnight(new Date(2026, 9, 19)), utcWallClockMidnight(new Date(2027, 9, 19)), true)
        const isoDays = bounded.map((date) => date.toISOString().slice(0, 10))
        expect(isoDays[0]).toBe('2026-10-25')
        expect(isoDays[isoDays.length - 1]).toBe('2027-09-26')
        const gaps = isoDays.slice(1).map((dayValue, index) =>
            (Date.parse(`${dayValue}T00:00:00Z`) - Date.parse(`${isoDays[index]}T00:00:00Z`)) / 86_400_000,
        )
        expect(gaps.length).toBeGreaterThan(10)
        expect(gaps.every((gap) => gap === 28)).toBe(true)
    })
})

describe('chrono-node contract', () => {
    it('keeps "next friday" apart from "friday"', () => {
        const now = new Date(2026, 9, 19)
        expect(day(chrono.parseDate('friday', now, { forwardDate: true })!)).toBe('2026-10-23')
        expect(day(chrono.parseDate('next friday', now, { forwardDate: true })!)).toBe('2026-10-30')
    })

    it('returns plain Dates and finds two dates in one string', () => {
        expect(chrono.parseDate('2026-10-21')).toBeInstanceOf(Date)
        const hits = chrono.parse('17 August 2013 19 August 2013')
        expect(hits).toHaveLength(2)
        expect(hits.map((hit) => day(hit.start.date()))).toEqual(['2013-8-17', '2013-8-19'])
    })

    it('yields null rather than a sentinel for unparseable input', () => {
        expect(chrono.parseDate('sometime soon-ish')).toBeNull()
    })
})

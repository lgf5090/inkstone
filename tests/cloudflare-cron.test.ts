// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cronMatches, isValidCron, parseCron } from '../src/worker/cloudflare/cron'

const at = (iso: string) => new Date(`${iso}Z`)

describe('the cron matcher', () => {
  it('matches every minute for * * * * *', () => {
    expect(cronMatches('* * * * *', at('2026-10-27T09:41:00'))).toBe(true)
  })

  it('matches a step, a range and a list', () => {
    expect(cronMatches('*/5 * * * *', at('2026-10-27T09:45:00'))).toBe(true)
    expect(cronMatches('*/5 * * * *', at('2026-10-27T09:41:00'))).toBe(false)
    expect(cronMatches('10-20/5 * * * *', at('2026-10-27T09:15:00'))).toBe(true)
    expect(cronMatches('10-20/5 * * * *', at('2026-10-27T09:16:00'))).toBe(false)
    expect(cronMatches('0 9,18 * * *', at('2026-10-27T18:00:00'))).toBe(true)
    expect(cronMatches('0 9,18 * * *', at('2026-10-27T10:00:00'))).toBe(false)
  })

  it('reads weekday 7 as Sunday and applies the OR rule when both days are restricted', () => {
    // 2026-10-25 is a Sunday.
    expect(cronMatches('0 0 * * 7', at('2026-10-25T00:00:00'))).toBe(true)
    expect(cronMatches('0 0 * * 0', at('2026-10-25T00:00:00'))).toBe(true)
    // 2026-10-27 is a Tuesday (weekday 2); either the date or the weekday may match when both are set.
    expect(cronMatches('0 0 27 * 2', at('2026-10-27T00:00:00'))).toBe(true)
    expect(cronMatches('0 0 28 * 2', at('2026-10-27T00:00:00'))).toBe(true)
    expect(cronMatches('0 0 28 * 3', at('2026-10-27T00:00:00'))).toBe(false)
  })

  it('refuses an expression it cannot read instead of guessing', () => {
    expect(isValidCron('* * * *')).toBe(false)
    expect(isValidCron('60 * * * *')).toBe(false)
    expect(isValidCron('*/0 * * * *')).toBe(false)
    expect(isValidCron('5-1 * * * *')).toBe(false)
    expect(isValidCron('abc * * * *')).toBe(false)
    expect(() => parseCron('* * * * * *')).toThrow()
    expect(cronMatches('not a cron', at('2026-10-27T09:41:00'))).toBe(false)
  })

  it('parses a full expression into the values a caller can inspect', () => {
    const fields = parseCron('0 6 * * 1-5')
    expect([...fields.minute]).toEqual([0])
    expect([...fields.hour]).toEqual([6])
    expect([...fields.dayOfWeek]).toEqual([1, 2, 3, 4, 5])
    expect(fields.dayOfMonthRestricted).toBe(false)
    expect(fields.dayOfWeekRestricted).toBe(true)
  })
})

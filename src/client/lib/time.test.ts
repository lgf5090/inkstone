import { describe, expect, it } from 'vitest'
import { dateKey, isDateKey, relativeTime, shortSince, weekStartFor } from './time'

describe('dateKey', () => {
  it('writes a four digit year for every date the range comparisons can meet', () => {
    expect(dateKey(new Date(999, 11, 31))).toBe('0999-12-31')
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(dateKey(new Date(9999, 11, 31))).toBe('9999-12-31')
    expect(dateKey(new Date(10_000, 0, 1))).toBe('9999-01-01')
    expect(dateKey(new Date(-1, 0, 1))).toBe('0001-01-01')
  })

  it('stays inside the sortable range when the stamp is nonsense', () => {
    const key = dateKey(new Date(Number.NaN))
    expect(isDateKey(key)).toBe(true)
    expect(key).toBe('1970-01-01')
  })

  it('sorts the way the calendar compares', () => {
    expect(dateKey(new Date(999, 11, 31)) < dateKey(new Date(1000, 0, 1))).toBe(true)
    // The old unpadded form put `10000-01-01` *before* `2026-01-01` as a string; clamped, a
    // far-future stamp still sorts after today.
    expect(dateKey(new Date(2026, 0, 1)) < dateKey(new Date(10_000, 0, 1))).toBe(true)
    expect('10000-01-01' < '2026-01-01').toBe(true)
  })
})

describe('isDateKey', () => {
  it('accepts only real days written in full', () => {
    for (const key of ['2026-01-01', '2026-02-28', '2024-02-29', '9999-12-31', '0001-01-01'])
      expect(isDateKey(key), key).toBe(true)
  })

  it('refuses what Date would silently roll over or reject', () => {
    for (const key of ['2026-13-45', '2026-02-30', '2026-00-10', '2026-01-00', '2026-1-1', '999-12-31', '10000-01-01', '', 'garbage', '2026-01-01T00:00:00Z'])
      expect(isDateKey(key), key).toBe(false)
    for (const value of [null, undefined, 20_260_101, new Date(2026, 0, 1)])
      expect(isDateKey(value as unknown), String(value)).toBe(false)
  })
})

describe('weekStartFor', () => {
  it('follows CLDR wherever the runtime reports it, and says so where it cannot', () => {
    const locale = new Intl.Locale('de-DE') as Intl.Locale & { getWeekInfo?: () => { firstDay?: number } }
    if (typeof locale.getWeekInfo !== 'function') {
      console.log('[weekStartFor] this runtime has no getWeekInfo; the shipped fallback is in force')
      return
    }
    expect(weekStartFor('de-DE')).toBe(1)
    expect(weekStartFor('fr-FR')).toBe(1)
    expect(weekStartFor('en-GB')).toBe(1)
    expect(weekStartFor('zh-CN')).toBe(1)
    expect(weekStartFor('en-US')).toBe(0)
    expect(weekStartFor('ja-JP')).toBe(0)
  })

  it('takes the older weekInfo getter from an engine without getWeekInfo', () => {
    const Real = Intl.Locale
    const tag = 'de-AT'
    // @ts-expect-error the double stands in for an engine that shipped only the getter form
    Intl.Locale = class LegacyLocale {
      get weekInfo() {
        return { firstDay: 1 }
      }
    }
    try {
      expect(weekStartFor(tag)).toBe(1)
    }
    finally {
      // @ts-expect-error restoring the real constructor
      Intl.Locale = Real
    }
  })

  it('builds one Intl.Locale per locale, not one per render', () => {
    const Real = Intl.Locale
    let built = 0
    class Counting extends Real {
      constructor(tag: string) {
        super(tag)
        built++
      }
    }
    // @ts-expect-error the double keeps the real constructor's shape and only counts calls
    Intl.Locale = Counting
    try {
      const first = weekStartFor('nl-NL')
      expect(weekStartFor('nl-NL')).toBe(first)
      expect(weekStartFor('nl-NL')).toBe(first)
      expect(built, 'a re-render must not re-derive locale data').toBe(1)
      weekStartFor('sv-SE')
      expect(built, 'a different locale is still its own answer').toBe(2)
    }
    finally {
      // @ts-expect-error restoring the real constructor
      Intl.Locale = Real
    }
  })
})

describe('shortSince', () => {
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  // A fixed `now`, so a run at 23:59 cannot disagree with a run at 00:01.
  const now = Date.UTC(2026, 9, 8, 12)
  const since = (ms: number) => shortSince(now - ms, now)
  const startsWith = (text: string, digits: string) => text.startsWith(digits)

  it('holds the first minute back as "just now" rather than a zero', () => {
    expect(since(1000)).toBe(since(59_000))
    expect(since(90_000)).not.toBe(since(30_000))
  })

  it('names the largest unit that has fully passed, and floors it', () => {
    expect(startsWith(since(59 * MINUTE), '59')).toBe(true)
    expect(startsWith(since(61 * MINUTE), '1')).toBe(true)
    expect(startsWith(since(23 * HOUR), '23')).toBe(true)
    expect(startsWith(since(25 * HOUR), '1')).toBe(true)
    expect(startsWith(since(29 * DAY), '29')).toBe(true)
    expect(startsWith(since(31 * DAY), '1')).toBe(true)
    expect(startsWith(since(364 * DAY), '12')).toBe(true)
    expect(startsWith(since(400 * DAY), '1')).toBe(true)
  })

  it('counts a stamp still in the future by the same distance', () => {
    expect(since(-2 * HOUR)).toBe(since(2 * HOUR))
  })

  it('is a duration, not the sentence relativeTime writes', () => {
    expect(since(3 * DAY)).not.toBe(relativeTime(now - 3 * DAY, now))
  })

  it('answers with a dash when there is no stamp to measure', () => {
    expect(shortSince(0, now)).toBe('—')
    expect(shortSince(Number.NaN, now)).toBe('—')
    expect(shortSince(now, Number.NaN)).toBe('—')
  })
})

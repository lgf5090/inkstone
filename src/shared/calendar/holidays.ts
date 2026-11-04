/**
 * The statutory holiday calendar, as the State Council actually published it.
 *
 * Every range below is copied from the General Office's notice for that year — notice 2024 No. 12
 * (published 2024-11-12) for 2025, and notice 2025 No. 7 (published 2025-11-04) for 2026 — and
 * nothing here is guessed. A year with no notice gets no row: an invented "likely" bridge day would be
 * worse than an empty month, because a reader could not tell the two apart.
 *
 * The table is shared rather than client-only for one reason: the same answer decides what the grid
 * prints and what a server-side export would write, and two copies would eventually disagree.
 */

import type { MessageKey } from '../locales/en-US'

export const HOLIDAY_YEARS = [2025, 2026] as const
export type HolidayYear = (typeof HOLIDAY_YEARS)[number]

export interface HolidayRange {
  /** First day off, `YYYY-MM-DD`, inclusive. */
  from: string
  /** Last day off, inclusive. */
  to: string
  name: MessageKey
  /** The notice this range came from, printed in the day panel so a reader can check it. */
  source: MessageKey
}

export interface MakeupWorkday {
  /** The Saturday or Sunday the notice turns back into a working day. */
  date: string
  /** Which holiday the shift belongs to. */
  name: MessageKey
  /** The notice that ordered the shift. */
  source: MessageKey
}

export interface HolidayNotice {
  year: HolidayYear
  /** The document number, shown verbatim in the day panel. */
  notice: MessageKey
  ranges: readonly HolidayRange[]
  makeup: readonly MakeupWorkday[]
}

/** Notice 2024 No. 12, published 2024-11-12; the catalog carries the document's own wording. */
const NOTICE_2025: MessageKey = 'calendar.holidays.notice_2025'

/** Notice 2025 No. 7, published 2025-11-04. */
const NOTICE_2026: MessageKey = 'calendar.holidays.notice_2026'

/**
 * 2025: Spring Festival runs eight days from New Year's Eve, and National Day swallows Mid-Autumn,
 * which is why that one range carries both names.
 */
const YEAR_2025: HolidayNotice = {
  year: 2025,
  notice: NOTICE_2025,
  ranges: [
    { from: '2025-01-01', to: '2025-01-01', name: 'calendar.holidays.new_year', source: NOTICE_2025 },
    { from: '2025-01-28', to: '2025-02-04', name: 'calendar.holidays.spring_festival', source: NOTICE_2025 },
    { from: '2025-04-04', to: '2025-04-06', name: 'calendar.holidays.qingming', source: NOTICE_2025 },
    { from: '2025-05-01', to: '2025-05-05', name: 'calendar.holidays.labor_day', source: NOTICE_2025 },
    { from: '2025-05-31', to: '2025-06-02', name: 'calendar.holidays.dragon_boat', source: NOTICE_2025 },
    { from: '2025-10-01', to: '2025-10-08', name: 'calendar.holidays.national_day_mid_autumn', source: NOTICE_2025 },
  ],
  makeup: [
    { date: '2025-01-26', name: 'calendar.holidays.spring_festival', source: NOTICE_2025 },
    { date: '2025-02-08', name: 'calendar.holidays.spring_festival', source: NOTICE_2025 },
    { date: '2025-04-27', name: 'calendar.holidays.labor_day', source: NOTICE_2025 },
    { date: '2025-09-28', name: 'calendar.holidays.national_day', source: NOTICE_2025 },
    { date: '2025-10-11', name: 'calendar.holidays.national_day', source: NOTICE_2025 },
  ],
}

/**
 * 2026: New Year is three days with one Sunday paid back, the Spring Festival is nine days, and the
 * National Day is split by two makeup Saturdays.
 */
const YEAR_2026: HolidayNotice = {
  year: 2026,
  notice: NOTICE_2026,
  ranges: [
    { from: '2026-01-01', to: '2026-01-03', name: 'calendar.holidays.new_year', source: NOTICE_2026 },
    { from: '2026-02-15', to: '2026-02-23', name: 'calendar.holidays.spring_festival', source: NOTICE_2026 },
    { from: '2026-04-04', to: '2026-04-06', name: 'calendar.holidays.qingming', source: NOTICE_2026 },
    { from: '2026-05-01', to: '2026-05-05', name: 'calendar.holidays.labor_day', source: NOTICE_2026 },
    { from: '2026-06-19', to: '2026-06-21', name: 'calendar.holidays.dragon_boat', source: NOTICE_2026 },
    { from: '2026-09-25', to: '2026-09-27', name: 'calendar.holidays.mid_autumn', source: NOTICE_2026 },
    { from: '2026-10-01', to: '2026-10-07', name: 'calendar.holidays.national_day', source: NOTICE_2026 },
  ],
  makeup: [
    { date: '2026-01-04', name: 'calendar.holidays.new_year', source: NOTICE_2026 },
    { date: '2026-02-14', name: 'calendar.holidays.spring_festival', source: NOTICE_2026 },
    { date: '2026-02-28', name: 'calendar.holidays.spring_festival', source: NOTICE_2026 },
    { date: '2026-05-09', name: 'calendar.holidays.labor_day', source: NOTICE_2026 },
    { date: '2026-09-20', name: 'calendar.holidays.national_day', source: NOTICE_2026 },
    { date: '2026-10-10', name: 'calendar.holidays.national_day', source: NOTICE_2026 },
  ],
}

export const HOLIDAY_NOTICES: readonly HolidayNotice[] = [YEAR_2025, YEAR_2026]

export function holidayNoticeOf(year: number): HolidayNotice | null {
  return HOLIDAY_NOTICES.find(entry => entry.year === year) ?? null
}

/** What one Gregorian day is, as the statutory calendar sees it. */
export interface HolidayDay {
  /** True when the notice puts this day off work. */
  off: boolean
  /** True when the notice turns an ordinary weekend into a working day. */
  makeup: boolean
  /** The holiday this day belongs to, or null on an ordinary day. */
  name: MessageKey | null
  /** The document the answer came from; null when the year has no notice in the table. */
  source: MessageKey | null
}

const OFF_DAYS = new Map<string, HolidayDay>()
const MAKEUP_DAYS = new Map<string, HolidayDay>()

for (const notice of HOLIDAY_NOTICES) {
  for (const range of notice.ranges) {
    for (const key of enumerate(range.from, range.to)) {
      OFF_DAYS.set(key, { off: true, makeup: false, name: range.name, source: range.source })
    }
  }
  for (const shift of notice.makeup) {
    MAKEUP_DAYS.set(shift.date, { off: false, makeup: true, name: shift.name, source: shift.source })
  }
}

const ORDINARY: HolidayDay = { off: false, makeup: false, name: null, source: null }

/** Inclusive walk between two `YYYY-MM-DD` keys; the table's ranges are decades at most. */
function enumerate(from: string, to: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let at = start; at <= end; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10))
  }
  return out
}

/**
 * Whether this day is off, a makeup workday, or neither.
 *
 * A makeup day wins over a range: the table never overlaps them, but reading one before the other
 * makes the precedence explicit rather than an accident of insertion order.
 */
export function holidayDay(key: string): HolidayDay {
  return MAKEUP_DAYS.get(key) ?? OFF_DAYS.get(key) ?? ORDINARY
}

/** The years the table can answer for, so a picker can refuse outside them instead of printing nothing. */
export function holidayYearsListed(): number[] {
  return HOLIDAY_NOTICES.map(entry => entry.year)
}

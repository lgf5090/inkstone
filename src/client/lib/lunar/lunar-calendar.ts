import {
  LUNAR_RANGE_END,
  LUNAR_RANGE_START,
  LUNAR_YEAR_TABLE,
  SOLAR_TERM_TABLE,
  TERM_NAMES,
  ganzhiOf,
  lunarDayName,
  lunarMonthName,
  zodiacOf,
} from './lunar-data'

const MS_PER_DAY = 86_400_000
const ROW_CHARS = 5
const TERM_CHARS = TERM_NAMES.length
const CACHE_LIMIT = 4096

export interface LunarDate {
  year: number
  month: number
  day: number
  isLeap: boolean
  monthName: string
  dayName: string
  ganzhi: string
  zodiac: string
  isYearStart: boolean
  isYearEnd: boolean
}

interface LunarMonth {
  month: number
  isLeap: boolean
  days: number
  startUtc: number
}

interface LunarYear {
  year: number
  startUtc: number
  endUtc: number
  months: LunarMonth[]
}

/**
 * The table stores each year's month lengths, not its start date, so the whole 1900-2100 frame is
 * walked once: a lunar year opens where the previous one's months run out. Doing it per lookup
 * instead would re-walk up to two centuries of months for every cell of every grid.
 */
function buildLunarYear(year: number, startUtc: number): LunarYear {
  const row = Number.parseInt(LUNAR_YEAR_TABLE.slice((year - LUNAR_RANGE_START) * ROW_CHARS, (year - LUNAR_RANGE_START + 1) * ROW_CHARS), 16)
  const leap = (row >> 13) & 0xf
  const flags = row & 0x1fff
  const count = leap === 0 ? 12 : 13
  const months: LunarMonth[] = []
  let cursor = startUtc
  for (let index = 0; index < count; index++) {
    const isLeap = leap !== 0 && index === leap
    const month = leap === 0 ? index + 1 : isLeap ? leap : index < leap ? index + 1 : index
    const days = (flags >> index) & 1 ? 30 : 29
    months.push({ month, isLeap, days, startUtc: cursor })
    cursor += days * MS_PER_DAY
  }
  return { year, startUtc, endUtc: cursor, months }
}

let years: LunarYear[] | null = null

function lunarYears(): LunarYear[] {
  if (!years) {
    const built: LunarYear[] = []
    let cursor = Date.UTC(LUNAR_RANGE_START, 0, 31)
    for (let year = LUNAR_RANGE_START; year <= LUNAR_RANGE_END; year++) {
      const next = buildLunarYear(year, cursor)
      built.push(next)
      cursor = next.endUtc
    }
    years = built
  }
  return years
}

function civilUtc(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
}

function findLunarYear(utc: number): LunarYear | null {
  const list = lunarYears()
  if (utc < list[0]!.startUtc || utc >= list[list.length - 1]!.endUtc)
    return null
  let low = 0
  let high = list.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (list[middle]!.startUtc <= utc)
      low = middle
    else
      high = middle - 1
  }
  return list[low]!
}

function computeLunar(utc: number): LunarDate | null {
  const year = findLunarYear(utc)
  if (!year)
    return null
  let slot = year.months.length - 1
  for (let index = 0; index < year.months.length - 1; index++) {
    if (year.months[index + 1]!.startUtc > utc) {
      slot = index
      break
    }
  }
  const month = year.months[slot]!
  const day = Math.floor((utc - month.startUtc) / MS_PER_DAY) + 1
  if (day < 1 || day > month.days)
    return null
  return {
    year: year.year,
    month: month.month,
    day,
    isLeap: month.isLeap,
    monthName: lunarMonthName(month.month, month.isLeap),
    dayName: lunarDayName(day),
    ganzhi: ganzhiOf(year.year),
    zodiac: zodiacOf(year.year),
    isYearStart: slot === 0 && day === 1,
    isYearEnd: slot === year.months.length - 1 && day === month.days,
  }
}

const lunarCache = new Map<number, LunarDate | null>()

/** The lunar date a Gregorian day falls on, or null outside the 1900-2100 table. */
export function lunarOf(date: Date): LunarDate | null {
  const utc = civilUtc(date)
  const hit = lunarCache.get(utc)
  if (hit !== undefined)
    return hit
  const found = computeLunar(utc)
  if (lunarCache.size > CACHE_LIMIT)
    lunarCache.clear()
  lunarCache.set(utc, found)
  return found
}

/** The Gregorian day a lunar year opens on, or null when that year is off the table. */
export function lunarYearStart(lunarYear: number): Date | null {
  const entry = lunarYears()[lunarYear - LUNAR_RANGE_START]
  if (!entry)
    return null
  const utc = new Date(entry.startUtc)
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
}

function computeSolarTerm(date: Date): string | null {
  const year = date.getFullYear()
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END)
    return null
  const row = SOLAR_TERM_TABLE.slice((year - LUNAR_RANGE_START) * TERM_CHARS, (year - LUNAR_RANGE_START + 1) * TERM_CHARS)
  const first = date.getMonth() * 2
  const day = date.getDate()
  for (const index of [first, first + 1]) {
    if (Number.parseInt(row[index]!, 32) === day)
      return TERM_NAMES[index] ?? null
  }
  return null
}

const termCache = new Map<number, string | null>()

/** The solar term falling on this Gregorian day. Beijing reckoning, so it is the same for every reader. */
export function solarTermOf(date: Date): string | null {
  const utc = civilUtc(date)
  const hit = termCache.get(utc)
  if (hit !== undefined)
    return hit
  const found = computeSolarTerm(date)
  if (termCache.size > CACHE_LIMIT)
    termCache.clear()
  termCache.set(utc, found)
  return found
}

/** All twenty-four terms of a Gregorian year, in calendar order. */
export function solarTermsOfYear(year: number): { name: string; date: Date }[] {
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END)
    return []
  const row = SOLAR_TERM_TABLE.slice((year - LUNAR_RANGE_START) * TERM_CHARS, (year - LUNAR_RANGE_START + 1) * TERM_CHARS)
  return TERM_NAMES.map((name, index) => ({
    name,
    date: new Date(Date.UTC(year, index >> 1, Number.parseInt(row[index]!, 32))),
  }))
}

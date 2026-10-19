/**
 * The Chinese lunar calendar, 1900-2100, as a pure conversion.
 *
 * A subscription may renew by the lunar calendar (a yearly plan that lands on the same lunar day), so
 * the worker needs both directions: solar to lunar to know where a period ends, and lunar to solar to
 * know which day to store. The notebook's own almanac module cannot help — it only reads forward, and
 * it is a client module built around month cells rather than around arithmetic.
 *
 * The forward conversion is the standard table walk. The inverse is computed rather than searched:
 * the reference project found the lunar day by scanning three solar years and asking the forward
 * function about each day, which is correct and about two hundred thousand operations per call. The
 * scheduler calls it once per due subscription per fire, so this version walks the months of one lunar
 * year instead, and a test pins it to the forward function across representative years.
 */

/** One packed year: leap-month number in the low nibble, month lengths and leap length in the rest. */
const LUNAR_INFO: readonly number[] = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x14a38, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x1a978, 0x16aa0, 0x0a6c0,
  0x0aa60, 0x16d63, 0x0d260, 0x0d950, 0x0d554, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7,
  0x025d0, 0x092d0, 0x0cab5, 0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0,
  0x15176, 0x052b0, 0x0a930, 0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0,
  0x0d260, 0x0ea65, 0x0d530, 0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x1a4bb, 0x0a4d0, 0x0d0b0,
  0x0d250,
]

/** The sexagenary cycle, kept as one value so the gate that reads vocabulary sees a single table. */
export const GANZI_VOCABULARY = {
  gan: ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'],
  zhi: ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'],
}

export const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']

export const LUNAR_DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

export const ALMANAC_TEXT = { leap: '闰', month: '月', year: '年' }

export const LUNAR_RANGE_START = 1900
export const LUNAR_RANGE_END = 2100

const BASE_UTC = Date.UTC(1900, 0, 31)

export interface LunarDate {
  year: number
  month: number
  day: number
  isLeap: boolean
  yearStr: string
  monthStr: string
  dayStr: string
  fullStr: string
}

/** Days in a lunar year, leap month included. */
export function lunarYearDays(year: number): number {
  let sum = 348
  for (let bit = 0x8000; bit > 0x8; bit >>= 1) {
    sum += (LUNAR_INFO[year - LUNAR_RANGE_START]! & bit) ? 1 : 0
  }
  return sum + leapDays(year)
}

/** The leap month of a lunar year, or 0 when it has none. */
export function leapMonth(year: number): number {
  return LUNAR_INFO[year - LUNAR_RANGE_START]! & 0xf
}

/** Days in a lunar year's leap month. */
export function leapDays(year: number): number {
  if (!leapMonth(year)) return 0
  return (LUNAR_INFO[year - LUNAR_RANGE_START]! & 0x10000) ? 30 : 29
}

/** Days in one lunar month (29 or 30). */
export function monthDays(year: number, month: number): number {
  return (LUNAR_INFO[year - LUNAR_RANGE_START]! & (0x10000 >> month)) ? 30 : 29
}

/**
 * Days from the epoch of the table to the first day of a lunar year.
 *
 * Built once and kept: the inverse conversion walks from here, and recomputing the sum on every call
 * would turn a per-subscription cost into a per-year one.
 */
let yearStarts: number[] | null = null

function lunarYearStartOffset(year: number): number {
  if (!yearStarts) {
    yearStarts = [0]
    for (let cursor = LUNAR_RANGE_START; cursor < LUNAR_RANGE_END; cursor++) {
      yearStarts.push(yearStarts[cursor - LUNAR_RANGE_START]! + lunarYearDays(cursor))
    }
  }
  return yearStarts[year - LUNAR_RANGE_START] ?? 0
}

/** Solar calendar fields to the lunar date they name, or null outside 1900-2100. */
export function solar2lunar(year: number, month: number, day: number): LunarDate | null {
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END) return null
  const target = Date.UTC(year, month - 1, day)
  if (Number.isNaN(target)) return null
  let offset = Math.round((target - BASE_UTC) / 86_400_000)

  let lunarYear = LUNAR_RANGE_START
  let temp = 0
  for (; lunarYear < LUNAR_RANGE_END + 1 && offset > 0; lunarYear++) {
    temp = lunarYearDays(lunarYear)
    offset -= temp
  }
  if (offset < 0) {
    offset += temp
    lunarYear--
  }

  let lunarMonth = 1
  const leap = leapMonth(lunarYear)
  let isLeap = false
  for (; lunarMonth < 13 && offset > 0; lunarMonth++) {
    if (leap > 0 && lunarMonth === leap + 1 && !isLeap) {
      lunarMonth--
      isLeap = true
      temp = leapDays(lunarYear)
    } else {
      temp = monthDays(lunarYear, lunarMonth)
    }
    if (isLeap && lunarMonth === leap + 1) isLeap = false
    offset -= temp
  }
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) isLeap = false
    else {
      isLeap = true
      lunarMonth--
    }
  }
  if (offset < 0) {
    offset += temp
    lunarMonth--
  }

  const lunarDay = offset + 1
  const ganIndex = (lunarYear - 4) % 10
  const zhiIndex = (lunarYear - 4) % 12
  const yearStr = `${GANZI_VOCABULARY.gan[ganIndex]}${GANZI_VOCABULARY.zhi[zhiIndex]}${ALMANAC_TEXT.year}`
  const monthStr = `${isLeap ? ALMANAC_TEXT.leap : ''}${LUNAR_MONTH_NAMES[lunarMonth - 1]}${ALMANAC_TEXT.month}`
  const dayStr = LUNAR_DAY_NAMES[lunarDay - 1]!
  return {
    year: lunarYear,
    month: lunarMonth,
    day: lunarDay,
    isLeap,
    yearStr,
    monthStr,
    dayStr,
    fullStr: `${yearStr}${monthStr}${dayStr}`,
  }
}

/** Lunar date to solar calendar fields, or null when the date does not exist. */
export function lunar2solar(lunar: Pick<LunarDate, 'year' | 'month' | 'day' | 'isLeap'>): { year: number; month: number; day: number } | null {
  const { year, month, day, isLeap } = lunar
  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END) return null
  if (month < 1 || month > 12 || day < 1) return null
  const leap = leapMonth(year)
  if (isLeap && leap !== month) return null
  if (day > (isLeap ? leapDays(year) : monthDays(year, month))) return null

  let offset = lunarYearStartOffset(year)
  for (let cursor = 1; cursor < month; cursor++) {
    offset += monthDays(year, cursor)
    if (leap === cursor) offset += leapDays(year)
  }
  if (isLeap) offset += monthDays(year, month)
  offset += day - 1

  const solar = new Date(BASE_UTC + offset * 86_400_000)
  return { year: solar.getUTCFullYear(), month: solar.getUTCMonth() + 1, day: solar.getUTCDate() }
}

/**
 * Advance a lunar date by a period, clamping the day into the target month.
 *
 * A lunar month is 29 or 30 days, so "the 30th, three months later" may not exist; the reference
 * project walks the day down until the combination resolves, which is what a reader means by "same
 * day next quarter" when the day is missing.
 */
export function addLunarPeriod(
  lunar: Pick<LunarDate, 'year' | 'month' | 'day' | 'isLeap'>,
  periodValue: number,
  periodUnit: 'day' | 'month' | 'year',
): Pick<LunarDate, 'year' | 'month' | 'day' | 'isLeap'> {
  let { year, month, day, isLeap } = lunar
  const amount = Math.trunc(periodValue)
  if (!Number.isFinite(amount) || amount === 0) return { year, month, day, isLeap }

  if (periodUnit === 'day') {
    const solar = lunar2solar({ year, month, day, isLeap })
    if (!solar) return { year, month, day, isLeap }
    const shifted = new Date(Date.UTC(solar.year, solar.month - 1, solar.day + amount))
    const next = solar2lunar(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
    return next ?? { year, month, day, isLeap }
  }

  if (periodUnit === 'year') {
    year += amount
    const leap = leapMonth(year)
    isLeap = isLeap && leap === month
  } else {
    const total = (year - LUNAR_RANGE_START) * 12 + (month - 1) + amount
    year = Math.floor(total / 12) + LUNAR_RANGE_START
    month = (total % 12) + 1
    const leap = leapMonth(year)
    isLeap = isLeap && leap === month
  }

  if (year < LUNAR_RANGE_START || year > LUNAR_RANGE_END) return { year, month, day, isLeap }
  const ceiling = isLeap ? leapDays(year) : monthDays(year, month)
  return { year, month, day: Math.min(day, ceiling), isLeap }
}

/** The lunar date an instant falls on, read in the given calendar fields' zone. */
export function lunarOfSolarFields(parts: { year: number; month: number; day: number }): LunarDate | null {
  return solar2lunar(parts.year, parts.month, parts.day)
}

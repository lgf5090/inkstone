import { formatLunarDate, lunarMonthCellName } from './lunar-data'
import { lunarOf, solarTermOf } from './lunar-calendar'

export interface AlmanacDay {
  /** The lunar day as a month cell can carry it: two characters, month name on the first day. */
  short: string
  /** The whole lunar date, sexagenary year through day name. */
  long: string
  /** A festival or solar term worth naming; where several land on one day, the highest rank wins. */
  highlight: string | null
  /** `highlight` squeezed into a month cell. */
  highlightShort: string | null
  /** True when the highlight names a solar term rather than a calendrical feast. */
  isTerm: boolean
  zodiac: string
}

/**
 * Festival names are proper nouns of the tradition, not interface copy: a reader switching the
 * app to English is asking for different chrome, not for Qingming to stop being called Qingming.
 * They live here for the same reason the sexagenary vocabulary does, which is also why the i18n
 * gate exempts this declaration by name.
 */
const FESTIVAL_DATA = {
  solar: {
    '01-01': '元旦',
    '02-14': '情人节',
    '03-08': '妇女节',
    '03-12': '植树节',
    '05-01': '劳动节',
    '05-04': '青年节',
    '06-01': '儿童节',
    '07-01': '建党节',
    '08-01': '建军节',
    '09-10': '教师节',
    '10-01': '国庆节',
    '11-08': '记者节',
    '12-04': '国家宪法日',
    '12-13': '公祭日',
  },
  lunar: {
    '1-1': '春节',
    '1-15': '元宵节',
    '2-2': '龙抬头',
    '3-3': '上巳节',
    '5-5': '端午节',
    '7-7': '七夕',
    '7-15': '中元节',
    '8-15': '中秋节',
    '9-9': '重阳节',
    '10-1': '寒衣节',
    '10-15': '下元节',
    '12-8': '腊八节',
    '12-23': '小年',
  },
  yearEnd: '除夕',
  terms: ['清明', '冬至'],
  ranks: {
    '春节': 100, '除夕': 99, '中秋节': 95, '端午节': 92, '元宵节': 90,
    '清明': 88, '冬至': 86, '七夕': 84, '重阳节': 82, '腊八节': 80,
    '小年': 78, '龙抬头': 76, '上巳节': 70, '中元节': 68, '寒衣节': 66,
    '下元节': 64, '元旦': 60, '劳动节': 58, '国庆节': 57, '儿童节': 55,
    '教师节': 52, '妇女节': 50, '青年节': 48, '建军节': 46, '建党节': 44,
    '植树节': 42, '情人节': 40, '记者节': 38, '公祭日': 36, '国家宪法日': 34,
    '母亲节': 32, '父亲节': 30,
  },
  mothersDay: '母亲节',
  fathersDay: '父亲节',
  /** A festival tile is as narrow as a lunar one, so the seasonal suffix comes off names long
   * enough to carry it; these four do not end in it and need naming by hand. */
  festivalSuffix: '节',
  shortCells: {
    '情人节': '情人',
    '龙抬头': '龙头',
    '公祭日': '公祭',
    '国家宪法日': '宪法',
  },
}

const SOLAR_FESTIVALS = FESTIVAL_DATA.solar
const LUNAR_FESTIVALS = FESTIVAL_DATA.lunar
const RANKS: Record<string, number> = FESTIVAL_DATA.ranks
const SHORT_CELLS: Record<string, string> = FESTIVAL_DATA.shortCells
const TERM_FESTIVALS = new Set<string>(FESTIVAL_DATA.terms)

/** The name that fits a month cell: two characters, with the full form kept for the tooltip. */
export function festivalCellName(name: string): string {
  if (name.length <= 2)
    return name
  const override = SHORT_CELLS[name]
  if (override)
    return override
  return name.endsWith(FESTIVAL_DATA.festivalSuffix) ? name.slice(0, -1) : name
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function rankOf(name: string): number {
  return RANKS[name] ?? 0
}

function isNthWeekday(date: Date, month: number, nth: number): boolean {
  return date.getMonth() + 1 === month && date.getDay() === 0 && Math.ceil(date.getDate() / 7) === nth
}

function bestOf(candidates: string[]): string | null {
  let best: string | null = null
  for (const name of candidates) {
    if (best === null || rankOf(name) > rankOf(best))
      best = name
  }
  return best
}

/** The one label worth printing for this day, or null when nothing names it and no lunar date exists. */
export function almanacOf(date: Date): AlmanacDay | null {
  const lunar = lunarOf(date)
  const term = solarTermOf(date)
  if (!lunar && !term)
    return null
  const key = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const candidates: string[] = []
  const solar = SOLAR_FESTIVALS[key as keyof typeof SOLAR_FESTIVALS]
  if (solar)
    candidates.push(solar)
  if (isNthWeekday(date, 5, 2))
    candidates.push(FESTIVAL_DATA.mothersDay)
  if (isNthWeekday(date, 6, 3))
    candidates.push(FESTIVAL_DATA.fathersDay)
  if (term && TERM_FESTIVALS.has(term))
    candidates.push(term)
  if (lunar) {
    if (lunar.isYearEnd)
      candidates.push(FESTIVAL_DATA.yearEnd)
    // A repeated leap month is not the month it repeats: the fifth month's fifth day is Duanwu
    // once, and the leap fifth month's fifth day is an ordinary day.
    if (!lunar.isLeap) {
      const named = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}` as keyof typeof LUNAR_FESTIVALS]
      if (named)
        candidates.push(named)
    }
  }
  const highlight = bestOf(candidates)
  return {
    short: lunar ? (lunar.day === 1 ? lunarMonthCellName(lunar.month, lunar.isLeap) : lunar.dayName) : (term ?? ''),
    long: lunar ? formatLunarDate(lunar) : '',
    highlight,
    highlightShort: highlight === null ? null : festivalCellName(highlight),
    isTerm: highlight !== null && highlight === term,
    zodiac: lunar?.zodiac ?? '',
  }
}
